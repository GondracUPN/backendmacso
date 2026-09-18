// src/tracking/tracking.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tracking, EstadoTracking } from './tracking.entity';
import { CreateTrackingDto } from './dto/create-tracking.dto';
import { UpdateTrackingDto } from './dto/update-tracking.dto';
import { Producto } from '../producto/producto.entity';
import { PersonalEshopex } from '../producto/personal-eshopex.entity';

@Injectable()
export class TrackingService {
  constructor(
    @InjectRepository(Tracking)
    private repo: Repository<Tracking>,
    @InjectRepository(Producto)
    private productoRepo: Repository<Producto>,
    @InjectRepository(PersonalEshopex)
    private personalEshopexRepo: Repository<PersonalEshopex>,
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

  private guideKeys(value?: string | null): string[] {
    const raw = this.clean(value);
    if (!raw) return [];
    const compact = raw.toLowerCase().replace(/\s+/g, '');
    const alphanumeric = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const digits = raw.replace(/\D+/g, '');
    return [...new Set([raw.toLowerCase(), compact, alphanumeric, digits.length >= 6 ? digits : ''].filter(Boolean))];
  }

  /**
   * Guias que todavia deben revisarse en el rastreo publico de Eshopex.
   * Se toma solo el tracking mas reciente de cada producto para no revivir
   * registros historicos que ya fueron reemplazados o recogidos.
   */
  async getPendingEshopexCodes(): Promise<string[]> {
    const trackingRows = await this.repo.find({
      select: ['id', 'productoId', 'trackingEshop', 'estado'],
      order: { id: 'DESC' },
    });
    const seenProducts = new Set<number>();
    const codes: string[] = [];
    for (const row of trackingRows) {
      if (seenProducts.has(row.productoId)) continue;
      seenProducts.add(row.productoId);
      const code = this.clean(row.trackingEshop);
      if (row.estado !== 'recogido' && code) codes.push(code);
    }

    const personalRows = await this.personalEshopexRepo.find();
    for (const item of personalRows) {
      const code = this.clean(item.trackingEshop);
      if (!item.recogido && code) codes.push(code);
    }

    const unique = new Map<string, string>();
    for (const code of codes) {
      const key = this.guideKeys(code).find((value) => /^\d{6,}$/.test(value))
        || this.guideKeys(code)[0];
      if (key && !unique.has(key)) unique.set(key, code);
    }
    return Array.from(unique.values());
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
    const incoming = new Map<string, string>();
    codes.forEach((code) => this.guideKeys(code).forEach((key) => incoming.set(key, statusByCode[code])));
    const allRows: Array<{ id: number; tracking_eshop: string }> = await this.repo.query(
      `SELECT id, tracking_eshop
       FROM (
         SELECT DISTINCT ON ("productoId") id, "productoId", tracking_eshop
         FROM tracking
         ORDER BY "productoId", id DESC
       ) latest
       WHERE tracking_eshop IS NOT NULL AND BTRIM(tracking_eshop) <> ''`,
    );
    const rows = allRows.filter((row) => this.guideKeys(row.tracking_eshop).some((key) => incoming.has(key)));
    if (rows.length) {
      const cases: string[] = [];
      const params: any[] = [];
      const ids: number[] = [];
      rows.forEach((row) => {
        const status = this.guideKeys(row.tracking_eshop).map((key) => incoming.get(key)).find(Boolean);
        if (!status) return;
        const idParam = params.length + 1;
        params.push(row.id);
        const statusParam = params.length + 1;
        params.push(status);
        cases.push(`WHEN $${idParam} THEN $${statusParam}`);
        ids.push(row.id);
      });
      if (ids.length) {
        const idsParams = ids.map((_, i) => `$${params.length + i + 1}`);
        params.push(...ids);
        await this.repo.query(
          `UPDATE tracking
           SET estatus_esho = CASE id ${cases.join(' ')} END
           WHERE id IN (${idsParams.join(',')})
             AND estatus_esho IS DISTINCT FROM CASE id ${cases.join(' ')} END`,
          params,
        );
      }
    }

    // Los paquetes ya guardados como Personal no vuelven a pendientes, pero su
    // estado visible debe avanzar cuando una busqueda manual trae un cambio.
    const personalRows = (await this.personalEshopexRepo.find()).filter((item) =>
      this.guideKeys(item.trackingEshop).some((key) => incoming.has(key)),
    );
    const changed = personalRows.filter((item) => {
      const next = this.guideKeys(item.trackingEshop).map((key) => incoming.get(key)).find(Boolean);
      return next && next !== item.estatusEsho;
    });
    if (changed.length) {
      changed.forEach((item) => {
        item.estatusEsho = this.guideKeys(item.trackingEshop).map((key) => incoming.get(key)).find(Boolean) || item.estatusEsho;
      });
      await this.personalEshopexRepo.save(changed);
    }
  }
}
