import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Gasto } from './entities/gasto.entity';
import { CreateGastoDto } from './dto/create-gasto.dto';
import { UpdateGastoDto } from './dto/update-gasto.dto';
import { Role } from '../auth/entities/user.entity';

function normConcept(con?: string) {
  return String(con || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_'); // "Compras cuotas" -> "compras_cuotas"
}

@Injectable()
export class GastosService {
  constructor(@InjectRepository(Gasto) private readonly repo: Repository<Gasto>) {}

  create(userId: number, dto: CreateGastoDto) {
    const concepto = normConcept(dto.concepto);
    const metodoPago: 'debito' | 'credito' =
      dto.metodoPago === 'credito' ? 'credito' : 'debito';
    const moneda: 'PEN' | 'USD' = dto.moneda === 'USD' ? 'USD' : 'PEN';

    const gasto = this.repo.create({
      userId,
      concepto, // siempre normalizado: comida | gusto | ingreso | pago_tarjeta | inversion | pago_envios | compras_cuotas ...
      detalleGusto: concepto === 'gusto' ? (dto.detalleGusto ?? null) : null,
      cuotasMeses:
        concepto === 'compras_cuotas' ? (dto.cuotasMeses ?? null) : null,
      moneda,
      monto: Number(dto.monto).toFixed(2),
      fecha: dto.fecha,
      metodoPago,
      // Guardamos la "tarjeta" para ambos métodos:
      // - crédito: tipo de tarjeta (interbank|bcp_amex|...)
      // - débito: banco (interbank|bcp|bbva) – útil para mostrar en la tabla
      tarjeta: dto.tarjeta ?? null,
      // si es pago a tarjeta hecho desde DÉBITO: destino a quien se paga
      tarjetaPago:
        metodoPago === 'debito' && concepto === 'pago_tarjeta'
          ? (dto.tarjetaPago ?? null)
          : null,
      notas: dto.notas ?? null,
    });

    return this.repo.save(gasto);
  }

  findAllByUser(userId: number) {
    return this.repo.find({
      where: { userId },
      order: { fecha: 'DESC', id: 'DESC' },
    });
  }

  /** Admin */
  findAll() {
    return this.repo.find({
      order: { userId: 'ASC', fecha: 'DESC', id: 'DESC' },
    });
  }

  private async getOrThrow(id: number) {
    const g = await this.repo.findOne({ where: { id } });
    if (!g) throw new NotFoundException('Gasto no encontrado');
    return g;
  }

  async update(userId: number, role: Role, id: number, dto: UpdateGastoDto) {
    const g = await this.getOrThrow(id);
    if (role !== 'admin' && g.userId !== userId) {
      throw new ForbiddenException('No autorizado');
    }

    // normalizaciones y asignaciones seguras
    if (dto.concepto !== undefined) g.concepto = normConcept(dto.concepto);
    if (dto.detalleGusto !== undefined) g.detalleGusto = dto.detalleGusto ?? null;
    if (dto.cuotasMeses !== undefined) g.cuotasMeses = dto.cuotasMeses ?? null;
    if (dto.moneda !== undefined) g.moneda = dto.moneda === 'USD' ? 'USD' : 'PEN';
    if (dto.monto !== undefined) g.monto = Number(dto.monto).toFixed(2);
    if (dto.fecha !== undefined) g.fecha = dto.fecha;

    if (dto.metodoPago !== undefined)
      g.metodoPago = dto.metodoPago === 'credito' ? ('credito' as any) : ('debito' as any);

    // siempre permitimos guardar "tarjeta" para mostrar (débito=banco, crédito=tarjeta)
    if (dto.tarjeta !== undefined) g.tarjeta = dto.tarjeta ?? null;

    // si el concepto es pago_tarjeta (y es débito), guardamos tarjetaPago; si cambia a otro concepto, limpiamos
    if (g.concepto === 'pago_tarjeta' && g.metodoPago === 'debito') {
      if (dto.tarjetaPago !== undefined) g.tarjetaPago = dto.tarjetaPago ?? null;
    } else {
      g.tarjetaPago = null;
    }

    if (dto.notas !== undefined) g.notas = dto.notas ?? null;

    return this.repo.save(g);
  }

  async remove(userId: number, role: Role, id: number) {
    const g = await this.getOrThrow(id);
    if (role !== 'admin' && g.userId !== userId) throw new ForbiddenException('No autorizado');
    await this.repo.remove(g);
    return { ok: true };
  }
}
