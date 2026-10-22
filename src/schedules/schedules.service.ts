import { Injectable, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { ScheduledCharge } from './scheduled-charge.entity';
import { CreateScheduledDto } from './dto/create-scheduled.dto';
import { UpdateScheduledDto } from './dto/update-scheduled.dto';
import { Gasto } from '../gastos/entities/gasto.entity';

import { addMonth } from './month-date';

@Injectable()
export class SchedulesService {
  constructor(
    @InjectRepository(ScheduledCharge) private readonly repo: Repository<ScheduledCharge>,
    @InjectRepository(Gasto) private readonly gastosRepo: Repository<Gasto>,
  ) {}

  create(userId: number, dto: CreateScheduledDto) {
    if (dto.tipo === 'cuotas' && (!Number.isInteger(dto.remaining) || Number(dto.remaining) < 1)) throw new BadRequestException('Indica el número de cuotas pendientes.');
    const sc = this.repo.create({
      userId,
      metodoPago: dto.metodoPago,
      tipo: dto.tipo,
      concepto: String(dto.concepto || '').trim().toLowerCase().replace(/\s+/g, '_'),
      moneda: dto.moneda,
      monto: Number(dto.monto).toFixed(2),
      nextDate: dto.nextDate.slice(0, 10),
      anchorDay: dto.anchorDay || Number(dto.nextDate.slice(8, 10)),
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

  async update(userId: number, id: number, dto: UpdateScheduledDto, manager?: EntityManager) {
    if (!manager) return this.repo.manager.transaction((em) => this.update(userId, id, dto, em));
    await manager.query('SELECT id FROM scheduled_charges WHERE id = $1 FOR UPDATE', [id]);
    const repo = manager.getRepository(ScheduledCharge);
    const sc = await repo.findOne({ where: { id } });
    if (!sc) throw new NotFoundException('Programación no encontrada');
    if (sc.userId !== userId) throw new ForbiddenException('No autorizado');
    Object.assign(sc, {
      metodoPago: dto.metodoPago ?? sc.metodoPago,
      tipo: dto.tipo ?? sc.tipo,
      concepto: dto.concepto ? String(dto.concepto).trim().toLowerCase().replace(/\s+/g, '_') : sc.concepto,
      moneda: dto.moneda ?? sc.moneda,
      monto: dto.monto != null ? Number(dto.monto).toFixed(2) : sc.monto,
      nextDate: dto.nextDate?.slice(0, 10) ?? sc.nextDate,
      anchorDay: dto.anchorDay ?? (dto.nextDate ? Number(dto.nextDate.slice(8, 10)) : sc.anchorDay),
      remaining: dto.remaining != null ? dto.remaining : sc.remaining,
      tarjeta: dto.tarjeta !== undefined ? dto.tarjeta ?? null : sc.tarjeta,
      tarjetaPago: dto.tarjetaPago !== undefined ? dto.tarjetaPago ?? null : sc.tarjetaPago,
    });
    return repo.save(sc);
  }

  async remove(userId: number, id: number, manager?: EntityManager) {
    if (!manager) return this.repo.manager.transaction((em) => this.remove(userId, id, em));
    await manager.query('SELECT id FROM scheduled_charges WHERE id = $1 FOR UPDATE', [id]);
    const repo = manager.getRepository(ScheduledCharge);
    const sc = await repo.findOne({ where: { id } });
    if (!sc) throw new NotFoundException('Programación no encontrada');
    if (sc.userId !== userId) throw new ForbiddenException('No autorizado');
    await repo.remove(sc);
    return { ok: true };
  }

  async processDue(userId: number, hasta = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' })) {
    return this.repo.manager.transaction(async (manager) => {
      await manager.query('SELECT id FROM scheduled_charges WHERE user_id = $1 AND active = true ORDER BY id FOR UPDATE', [userId]);
      const repo = manager.getRepository(ScheduledCharge);
      const gastos = manager.getRepository(Gasto);
      const list = await repo.find({ where: { userId, active: true }, order: { id: 'ASC' } });
      const generated: number[] = [];
      for (const sc of list) {
        // Compatibilidad con programaciones antiguas que guardaban el banco de
        // débito en tarjetaPago. No se inventa una cuenta si falta el dato.
        const banco = sc.tarjeta || (sc.metodoPago === 'debito' && sc.concepto !== 'pago_tarjeta' ? sc.tarjetaPago : null);
        if (sc.nextDate <= hasta && !banco) throw new BadRequestException('Selecciona el banco o tarjeta de la programación #' + sc.id);
        sc.anchorDay = sc.anchorDay || Number((sc.lastDate || sc.nextDate).slice(8, 10));
        while (sc.active && sc.nextDate <= hasta) {
          if (sc.tipo === 'cuotas' && (sc.remaining == null || !Number.isInteger(sc.remaining))) throw new BadRequestException('Revisa el número de cuotas de la programación #' + sc.id);
          if (sc.tipo === 'cuotas' && sc.remaining! <= 0) { sc.active = false; await repo.save(sc); break; }
          const period = sc.nextDate.slice(0, 7) + '-01';
          const existing = await gastos.findOne({ where: { scheduledChargeId: sc.id, scheduledPeriod: period } });
          if (!existing) {
            const gasto = gastos.create({ userId, concepto: sc.concepto, cuotasMeses: null, moneda: sc.moneda,
              monto: Number(sc.monto).toFixed(2), montoPen: sc.moneda === 'PEN' ? Number(sc.monto).toFixed(2) : null,
              fecha: sc.nextDate, metodoPago: sc.metodoPago, tarjeta: banco,
              tarjetaPago: sc.metodoPago === 'debito' && sc.concepto === 'pago_tarjeta' ? sc.tarjetaPago || null : null,
              notas: null, scheduledChargeId: sc.id, scheduledPeriod: period });
            await gastos.save(gasto); generated.push(sc.id);
          }
          sc.lastDate = sc.nextDate; sc.nextDate = addMonth(sc.nextDate, sc.anchorDay);
          if (sc.tipo === 'cuotas' && sc.remaining != null) { sc.remaining -= 1; if (sc.remaining <= 0) sc.active = false; }
          await repo.save(sc);
        }
      }
      return { ok: true, processed: generated };
    });
  }
}
