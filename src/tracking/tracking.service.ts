// src/tracking/tracking.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tracking, EstadoTracking } from './tracking.entity';
import { CreateTrackingDto } from './dto/create-tracking.dto';
import { UpdateTrackingDto } from './dto/update-tracking.dto';
import { Producto } from '../producto/producto.entity';

@Injectable()
export class TrackingService {
  constructor(
    @InjectRepository(Tracking)
    private repo: Repository<Tracking>,
    @InjectRepository(Producto)
    private productoRepo: Repository<Producto>,
  ) {}

  /** Devuelve el tracking más reciente para un producto (si existieran varios) */
  async findByProducto(productoId: number): Promise<Tracking | null> {
    const rows = await this.repo.find({
      where: { productoId },
      order: { id: 'DESC' },
      take: 1,
    });
    return rows[0] ?? null;
  }

  /** Crea un tracking con estado calculado o por defecto 'comprado_sin_tracking' */
  async create(dto: CreateTrackingDto): Promise<Tracking> {
    const estadoCalc = this.calcularEstado(dto);
    const estado: EstadoTracking = estadoCalc ?? 'comprado_sin_tracking';

    const t = this.repo.create({ ...dto, estado });
    const saved = await this.repo.save(t);
    await this.syncFacturaFlag(saved.productoId, estado);
    await this.propagateToGrupo(saved.productoId, saved);
    return saved;
  }

  /** Actualiza un tracking por ID recalculando el estado en base al merge */
  async update(id: number, dto: UpdateTrackingDto): Promise<Tracking> {
    const t = await this.repo.findOne({ where: { id } });
    if (!t) throw new NotFoundException(`Tracking ${id} no encontrado`);

    const merged = { ...t, ...dto };
    const estado: EstadoTracking =
      this.calcularEstado(merged) ?? 'comprado_sin_tracking';

    Object.assign(t, dto, { estado });
    await this.repo.save(t);
    await this.syncFacturaFlag(t.productoId, estado);
    await this.propagateToGrupo(t.productoId, { ...t });

    return this.repo.findOneOrFail({ where: { id: t.id } });
  }

  /** Obtiene el tracking por producto o lo crea con estado 'comprado_sin_tracking' */
  async getOrCreateByProducto(productoId: number): Promise<Tracking> {
    const existing = await this.findByProducto(productoId);
    if (existing) return existing;

    const created = this.repo.create({
      productoId,
      estado: 'comprado_sin_tracking',
    } as Partial<Tracking>); // cast parcial para evitar quejas de TS en campos opcionales
    return this.repo.save(created);
  }

  /** Upsert por producto (útil para el controller: PUT /tracking/producto/:pid) */
  async upsertByProducto(
    productoId: number,
    dto: Omit<CreateTrackingDto, 'productoId'>,
  ): Promise<Tracking> {
    const existing = await this.findByProducto(productoId);
    if (existing) {
      return this.update(existing.id, dto as UpdateTrackingDto);
    }
    return this.create({ ...dto, productoId });
  }

  /** Determina el estado según campos de USA/Eshopex/fechas */
  private calcularEstado(input: {
    trackingUsa?: string | null;
    transportista?: string | null;
    casillero?: string | null;
    trackingEshop?: string | null;
    estatusEsho?: string | null;
    fechaRecepcion?: string | null;
    fechaRecogido?: string | null;
  }): EstadoTracking {
    const hasUsa =
      !!this.clean(input.trackingUsa) || !!this.clean(input.transportista);

    const hasEshop =
      !!this.clean(input.trackingEshop) || !!this.clean(input.fechaRecepcion);

    if (this.clean(input.fechaRecogido)) return 'recogido';
    if (hasEshop) return 'en_eshopex';
    if (hasUsa) return 'comprado_en_camino';
    return 'comprado_sin_tracking';
  }

  private clean(v?: string | null): string | null {
    if (v == null) return null;
    const s = String(v).trim();
    return s.length ? s : null;
  }

  // Propaga tracking a todos los productos del mismo grupo de envío
  private async propagateToGrupo(productoId: number, tracking: Partial<Tracking>): Promise<void> {
    if (!productoId) return;
    const prod = await this.productoRepo.findOne({ where: { id: productoId } });
    if (!prod?.envioGrupoId) return;

    const peers = await this.productoRepo.find({ where: { envioGrupoId: prod.envioGrupoId } });
    const payload: UpdateTrackingDto = {
      trackingUsa: tracking.trackingUsa ?? undefined,
      transportista: tracking.transportista ?? undefined,
      casillero: tracking.casillero ?? undefined,
      trackingEshop: tracking.trackingEshop ?? undefined,
      estatusEsho: (tracking as any)?.estatusEsho ?? undefined,
      fechaRecepcion: (tracking as any)?.fechaRecepcion ?? null,
      fechaRecogido: (tracking as any)?.fechaRecogido ?? null,
    };

    for (const peer of peers) {
      if (peer.id === productoId) continue;
      const existing = await this.findByProducto(peer.id);
      const merged = existing ? { ...existing, ...payload } : { ...payload, productoId: peer.id };
      const estado = this.calcularEstado(merged) ?? 'comprado_sin_tracking';
      if (existing) {
        await this.repo.save({ ...existing, ...payload, estado });
        await this.syncFacturaFlag(peer.id, estado);
      } else {
        const created = this.repo.create({ ...merged, estado } as any);
        await this.repo.save(created);
        await this.syncFacturaFlag(peer.id, estado);
      }
    }
  }

  private async syncFacturaFlag(
    productoId: number,
    estado: EstadoTracking,
  ): Promise<void> {
    if (!productoId) return;
    if (estado !== 'en_eshopex' && estado !== 'recogido') return;
    await this.productoRepo.update(
      { id: productoId, facturaDecSubida: false },
      { facturaDecSubida: true },
    );
  }

  async updateEstatusEshoBulk(statusByCode: Record<string, string>): Promise<void> {
    const codes = Object.keys(statusByCode || {})
      .map((c) => this.clean(c))
      .filter(Boolean) as string[];
    if (!codes.length) return;
    const rows: Array<{ id: number; tracking_eshop: string }> = await this.repo.query(
      `SELECT DISTINCT ON (tracking_eshop) id, tracking_eshop
       FROM tracking
       WHERE tracking_eshop = ANY($1)
       ORDER BY tracking_eshop, id DESC`,
      [codes],
    );
    if (!rows.length) return;
    const cases: string[] = [];
    const params: any[] = [];
    const ids: number[] = [];
    rows.forEach((row) => {
      const status = statusByCode[row.tracking_eshop];
      if (!status) return;
      const idParam = params.length + 1;
      params.push(row.id);
      const statusParam = params.length + 1;
      params.push(status);
      cases.push(`WHEN $${idParam} THEN $${statusParam}`);
      ids.push(row.id);
    });
    if (!ids.length) return;
    const idsParams = ids.map((_, i) => `$${params.length + i + 1}`);
    params.push(...ids);
    await this.repo.query(
      `UPDATE tracking
       SET estatus_esho = CASE id ${cases.join(' ')} END
       WHERE id IN (${idsParams.join(',')})`,
      params,
    );
  }
}
