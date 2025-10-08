import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ScheduledCharge } from './scheduled-charge.entity';
import { CreateScheduledDto } from './dto/create-scheduled.dto';
import { UpdateScheduledDto } from './dto/update-scheduled.dto';
import { Gasto } from '../gastos/entities/gasto.entity';

function addMonth(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setMonth(d.getMonth() + 1);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

@Injectable()
export class SchedulesService {
  constructor(
    @InjectRepository(ScheduledCharge) private readonly repo: Repository<ScheduledCharge>,
    @InjectRepository(Gasto) private readonly gastosRepo: Repository<Gasto>,
  ) {}

  create(userId: number, dto: CreateScheduledDto) {
    const sc = this.repo.create({
      userId,
      metodoPago: dto.metodoPago,
      tipo: dto.tipo,
      concepto: String(dto.concepto || '').trim().toLowerCase().replace(/\s+/g, '_'),
      moneda: dto.moneda,
      monto: Number(dto.monto).toFixed(2),
      nextDate: dto.nextDate,
      lastDate: null,
      remaining: dto.tipo === 'cuotas' ? (dto.remaining ?? null) : null,
      tarjeta: dto.tarjeta ?? null,
      tarjetaPago: dto.tarjetaPago ?? null,
      active: true,
    });
    return this.repo.save(sc);
  }

  findAllByUser(userId: number) {
    return this.repo.find({ where: { userId }, order: { nextDate: 'ASC', id: 'ASC' } });
  }

  async update(userId: number, id: number, dto: UpdateScheduledDto) {
    const sc = await this.repo.findOne({ where: { id } });
    if (!sc) throw new NotFoundException('Programación no encontrada');
    if (sc.userId !== userId) throw new ForbiddenException('No autorizado');
    Object.assign(sc, {
      metodoPago: dto.metodoPago ?? sc.metodoPago,
      tipo: dto.tipo ?? sc.tipo,
      concepto: dto.concepto ? String(dto.concepto).trim().toLowerCase().replace(/\s+/g, '_') : sc.concepto,
      moneda: dto.moneda ?? sc.moneda,
      monto: dto.monto != null ? Number(dto.monto).toFixed(2) : sc.monto,
      nextDate: dto.nextDate ?? sc.nextDate,
      remaining: dto.remaining != null ? dto.remaining : sc.remaining,
      tarjeta: dto.tarjeta !== undefined ? dto.tarjeta ?? null : sc.tarjeta,
      tarjetaPago: dto.tarjetaPago !== undefined ? dto.tarjetaPago ?? null : sc.tarjetaPago,
    });
    return this.repo.save(sc);
  }

  async remove(userId: number, id: number) {
    const sc = await this.repo.findOne({ where: { id } });
    if (!sc) throw new NotFoundException('Programación no encontrada');
    if (sc.userId !== userId) throw new ForbiddenException('No autorizado');
    await this.repo.remove(sc);
    return { ok: true };
  }

  async processDue(userId: number) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;

    const list = await this.repo.find({ where: { userId, active: true } });
    const generated: number[] = [];
    for (const sc of list) {
      if (sc.nextDate <= todayStr) {
        const g = this.gastosRepo.create({
          userId,
          concepto: sc.concepto,
          detalleGusto: sc.concepto === 'gusto' ? null : null,
          cuotasMeses: null,
          moneda: sc.moneda,
          monto: Number(sc.monto).toFixed(2),
          fecha: sc.nextDate,
          metodoPago: sc.metodoPago,
          tarjeta: sc.metodoPago === 'credito' ? sc.tarjeta ?? null : null,
          tarjetaPago: sc.metodoPago === 'debito' ? sc.tarjetaPago ?? null : null,
          notas: null,
        });
        await this.gastosRepo.save(g);
        generated.push(sc.id);
        sc.lastDate = sc.nextDate;
        sc.nextDate = addMonth(sc.nextDate);
        if (sc.tipo === 'cuotas' && sc.remaining != null) {
          sc.remaining = Math.max(0, sc.remaining - 1);
          if (sc.remaining === 0) sc.active = false;
        }
        await this.repo.save(sc);
      }
    }
    return { ok: true, processed: generated };
  }
}

