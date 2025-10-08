import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Gasto } from './entities/gasto.entity';
import { CreateGastoDto } from './dto/create-gasto.dto';
import { UpdateGastoDto } from './dto/update-gasto.dto';
import { Role } from '../auth/entities/user.entity';

function normConcept(con?: string) {
  const raw = String(con || '').trim().toLowerCase();
  const s = raw.replace(/\s+/g, ' ');
  const map: Record<string, string> = {
    comida: 'comida',
    gusto: 'gusto',
    gustos: 'gusto',
    ingreso: 'ingreso',
    ingresos: 'ingreso',
    'pago tarjeta': 'pago_tarjeta',
    'pago de tarjeta': 'pago_tarjeta',
    pago_tarjeta: 'pago_tarjeta',
    'pago envios': 'pago_envios',
    pago_envios: 'pago_envios',
    inversion: 'inversion',
    inversiones: 'inversion',
    'deuda en cuotas': 'deuda_cuotas',
    deuda_en_cuotas: 'deuda_cuotas',
    'compras cuotas': 'deuda_cuotas',
    compras_cuotas: 'deuda_cuotas',
    'gastos recurrentes': 'gastos_recurrentes',
    'gasto recurrente': 'gastos_recurrentes',
  };
  const m = map[s] || s.replace(/\s+/g, '_');
  return m;
}

@Injectable()
export class GastosService {
  constructor(@InjectRepository(Gasto) private readonly repo: Repository<Gasto>) {}

  create(userId: number, dto: CreateGastoDto) {
    const concepto = normConcept(dto.concepto);
    const metodoPago: 'debito' | 'credito' = dto.metodoPago === 'credito' ? 'credito' : 'debito';
    // Si es crédito, forzamos USD (los consumos de tarjeta se guardan en USD)
    const moneda: 'PEN' | 'USD' = metodoPago === 'credito' ? 'USD' : dto.moneda === 'USD' ? 'USD' : 'PEN';

    // Validación de conceptos permitidos por método
    const allowedDeb = new Set(['comida', 'gusto', 'ingreso', 'pago_tarjeta']);
    const allowedCred = new Set(['comida', 'gusto', 'inversion', 'pago_envios', 'deuda_cuotas', 'gastos_recurrentes']);
    if ((metodoPago === 'debito' && !allowedDeb.has(concepto)) || (metodoPago === 'credito' && !allowedCred.has(concepto))) {
      throw new BadRequestException(`Concepto no permitido para ${metodoPago}`);
    }

    const gasto = this.repo.create({
      userId,
      concepto,
      detalleGusto: concepto === 'gusto' ? (dto.detalleGusto ?? null) : null,
      cuotasMeses: concepto === 'deuda_cuotas' ? (dto.cuotasMeses ?? null) : null,
      moneda,
      monto: Number(dto.monto).toFixed(2),
      fecha: dto.fecha,
      metodoPago,
      // Guardamos la "tarjeta" para ambos métodos (débito=banco, crédito=tarjeta)
      tarjeta: dto.tarjeta ?? null,
      // si es pago a tarjeta hecho desde DÉBITO: destino a quien se paga
      tarjetaPago: metodoPago === 'debito' && concepto === 'pago_tarjeta' ? (dto.tarjetaPago ?? null) : null,
      notas: dto.notas ?? null,
      // Nuevos campos opcionales para conversión / objetivo de pago
      tasaUsdPen:
        dto.tipoCambioDia != null && isFinite(Number(dto.tipoCambioDia))
          ? (Number(dto.tipoCambioDia).toFixed(4) as any)
          : null,
      montoPen:
        moneda === 'PEN'
          ? (Number(dto.monto).toFixed(2) as any)
          : (dto.tipoCambioDia != null && isFinite(Number(dto.tipoCambioDia))
              ? (Number(dto.monto) * Number(dto.tipoCambioDia)).toFixed(2)
              : null),
      pagoObjetivo:
        metodoPago === 'debito' && concepto === 'pago_tarjeta' && (dto.pagoObjetivo === 'USD' || dto.pagoObjetivo === 'PEN')
          ? (dto.pagoObjetivo as any)
          : null,
      montoUsdAplicado:
        metodoPago === 'debito' && concepto === 'pago_tarjeta' && dto.pagoObjetivo === 'USD'
          ? (Number(
              dto.montoUsdAplicado != null
                ? dto.montoUsdAplicado
                : (dto.moneda === 'PEN'
                    ? Number(dto.monto) / Number((dto.tipoCambioDia != null ? dto.tipoCambioDia : 3.7))
                    : Number(dto.monto))
            ).toFixed(2) as any)
          : null,
    });

    return this.repo.save(gasto);
  }

  findAllByUser(userId: number) {
    return this.repo.find({ where: { userId }, order: { fecha: 'DESC', id: 'DESC' } });
  }

  /** Admin */
  findAll() {
    return this.repo.find({ order: { userId: 'ASC', fecha: 'DESC', id: 'DESC' } });
  }

  private async getOrThrow(id: number) {
    const g = await this.repo.findOne({ where: { id } });
    if (!g) throw new NotFoundException('Gasto no encontrado');
    return g;
  }

  async findOneAuth(userId: number, role: Role, id: number) {
    const g = await this.getOrThrow(id);
    if (role !== 'admin' && g.userId !== userId) {
      throw new ForbiddenException('No autorizado');
    }
    return g;
  }

  async update(userId: number, role: Role, id: number, dto: UpdateGastoDto) {
    const g = await this.getOrThrow(id);
    if (role !== 'admin' && g.userId !== userId) {
      throw new ForbiddenException('No autorizado');
    }

    if (dto.concepto !== undefined) g.concepto = normConcept(dto.concepto);
    if (dto.detalleGusto !== undefined) g.detalleGusto = dto.detalleGusto ?? null;
    if (dto.cuotasMeses !== undefined) g.cuotasMeses = dto.cuotasMeses ?? null;
    if (dto.monto !== undefined) g.monto = Number(dto.monto).toFixed(2);
    if (dto.fecha !== undefined) g.fecha = dto.fecha;

    if (dto.metodoPago !== undefined) g.metodoPago = dto.metodoPago === 'credito' ? ('credito' as any) : ('debito' as any);

    if (dto.moneda !== undefined) {
      if (g.metodoPago === 'credito' || dto.metodoPago === 'credito') {
        g.moneda = 'USD' as any;
      } else {
        g.moneda = dto.moneda === 'USD' ? 'USD' : 'PEN';
      }
    }

    if (dto.tarjeta !== undefined) g.tarjeta = dto.tarjeta ?? null;

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
