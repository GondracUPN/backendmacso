// src/tracking/tracking.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tracking, EstadoTracking } from './tracking.entity';
import { CreateTrackingDto } from './dto/create-tracking.dto';
import { UpdateTrackingDto } from './dto/update-tracking.dto';

@Injectable()
export class TrackingService {
  constructor(
    @InjectRepository(Tracking)
    private repo: Repository<Tracking>,
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
    return this.repo.save(t);
  }

  /** Actualiza un tracking por ID recalculando el estado en base al merge */
  async update(id: number, dto: UpdateTrackingDto): Promise<Tracking> {
    const t = await this.repo.findOne({ where: { id } });
    if (!t) throw new NotFoundException(`Tracking ${id} no encontrado`);

    const merged = { ...t, ...dto };
    const estado: EstadoTracking = this.calcularEstado(merged) ?? 'comprado_sin_tracking';

    Object.assign(t, dto, { estado });
    await this.repo.save(t);

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
  async upsertByProducto(productoId: number, dto: Omit<CreateTrackingDto, 'productoId'>): Promise<Tracking> {
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
    fechaRecepcion?: string | null;
    fechaRecogido?: string | null;
  }): EstadoTracking {
    const hasUsa =
      !!this.clean(input.trackingUsa) ||
      !!this.clean(input.transportista);

    const hasEshop =
      !!this.clean(input.trackingEshop) ||
      !!this.clean(input.fechaRecepcion);

    if (this.clean(input.fechaRecogido)) return 'recogido';
    if (hasEshop) return 'en_eshopex';
    if (hasUsa)   return 'comprado_en_camino';
    return 'comprado_sin_tracking';
  }

  private clean(v?: string | null): string | null {
    if (v == null) return null;
    const s = String(v).trim();
    return s.length ? s : null;
  }
}
