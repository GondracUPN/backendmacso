import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Gasto } from './entities/gasto.entity';
import { GastoBudget } from './entities/gasto-budget.entity';
import { CreateGastoDto } from './dto/create-gasto.dto';
import { UpdateGastoDto } from './dto/update-gasto.dto';
import { UpsertGastoBudgetDto } from './dto/upsert-gasto-budget.dto';
import { Role } from '../auth/entities/user.entity';
import { ScheduledCharge } from '../schedules/scheduled-charge.entity';
import { CatalogService } from '../catalog/catalog.service';

function normConcept(con?: string) {
  const raw = String(con || '').trim().toLowerCase();
  const s = raw.replace(/\s+/g, ' ');
  const map: Record<string, string> = {
    comida: 'comida',
    gusto: 'gusto',
    gustos: 'gusto',
    transporte: 'transporte',
    reinicio: 'reinicio',
    cashback: 'cashback',
    'cash back': 'cashback',
    devolucion: 'cashback',
    devolución: 'cashback',
    bolsa: 'bolsa',
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
    'gastos mensuales': 'gastos_recurrentes',
    'gasto mensual': 'gastos_recurrentes',
  };
  const m = map[s] || s.replace(/\s+/g, '_');
  return m;
}

@Injectable()
export class GastosService {
  constructor(
    @InjectRepository(Gasto) private readonly repo: Repository<Gasto>,
    @InjectRepository(GastoBudget) private readonly budgetsRepo: Repository<GastoBudget>,
    @InjectRepository(ScheduledCharge) private readonly schedulesRepo: Repository<ScheduledCharge>,
    private readonly catalogService: CatalogService,
  ) {}

  private async isConceptAllowed(concepto: string, metodoPago: 'debito' | 'credito') {
    const allowedDeb = new Set(['comida', 'gusto', 'ingreso', 'pago_tarjeta', 'retiro_agente', 'gastos_recurrentes', 'transporte', 'pago_envios', 'cashback', 'bolsa']);
    const allowedCred = new Set(['comida', 'gusto', 'inversion', 'pago_envios', 'deuda_cuotas', 'gastos_recurrentes', 'desgravamen', 'transporte', 'reinicio', 'cashback']);
    if (metodoPago === 'debito' && allowedDeb.has(concepto)) return true;
    if (metodoPago === 'credito' && allowedCred.has(concepto)) return true;
    return this.catalogService.isExpenseConceptAllowed(concepto, metodoPago);
  }

  private addMonth(dateStr: string): string {
    const d = new Date(dateStr + 'T00:00:00');
    d.setMonth(d.getMonth() + 1);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  async create(userId: number, dto: CreateGastoDto) {
    const concepto = normConcept(dto.concepto);
    const metodoPago: 'debito' | 'credito' = dto.metodoPago === 'credito' ? 'credito' : 'debito';
    // Si es crédito, forzamos USD (los consumos de tarjeta se guardan en USD)
    const moneda: 'PEN' | 'USD' = dto.moneda === 'USD' ? 'USD' : 'PEN';

    if (!(await this.isConceptAllowed(concepto, metodoPago))) {
      throw new BadRequestException(`Concepto no permitido para ${metodoPago}`);
    }

    const notas =
      dto.notas != null
        ? dto.notas
        : (dto as any).detalleGusto != null && concepto === 'gusto'
          ? (dto as any).detalleGusto
          : null;

    const montoNum = Number(dto.monto);
    const montoSigned = concepto === 'cashback' ? -Math.abs(montoNum) : montoNum;

    const gasto = this.repo.create({
      userId,
      concepto,
      // detalleGusto eliminado: se usa notas
      cuotasMeses: concepto === 'deuda_cuotas' ? (dto.cuotasMeses ?? null) : null,
      moneda,
      monto: montoSigned.toFixed(2),
      fecha: dto.fecha,
      metodoPago,
      // Guardamos la "tarjeta" para ambos métodos (débito=banco, crédito=tarjeta)
      tarjeta: dto.tarjeta ?? null,
      // si es pago a tarjeta hecho desde DÉBITO: destino a quien se paga
      tarjetaPago: metodoPago === 'debito' && concepto === 'pago_tarjeta' ? (dto.tarjetaPago ?? null) : null,
      notas: notas ?? null,
      // Nuevos campos opcionales para conversión / objetivo de pago
      tasaUsdPen:
        ((): any => {
          const DEFAULT_USD_RATE = 3.7;
          const tc = dto.tipoCambioDia != null && isFinite(Number(dto.tipoCambioDia)) ? Number(dto.tipoCambioDia) : null;
          if (moneda === 'USD') return ((tc ?? DEFAULT_USD_RATE).toFixed(4) as any);
          return (tc != null ? (tc.toFixed(4) as any) : null);
        })(),
      montoPen:
        ((): any => {
          const DEFAULT_USD_RATE = 3.7;
          if (moneda === 'PEN') return (montoSigned.toFixed(2) as any);
          const tc = dto.tipoCambioDia != null && isFinite(Number(dto.tipoCambioDia)) ? Number(dto.tipoCambioDia) : DEFAULT_USD_RATE;
          return ((montoSigned * tc).toFixed(2) as any);
        })(),
      pagoObjetivo:

        metodoPago === 'debito' && (concepto === 'pago_tarjeta' || concepto === 'bolsa') && (dto.pagoObjetivo === 'USD' || dto.pagoObjetivo === 'PEN')
          ? (dto.pagoObjetivo as any)
          : null,
      montoUsdAplicado:
        metodoPago === 'debito' && (concepto === 'pago_tarjeta' || concepto === 'bolsa') && dto.pagoObjetivo === 'USD'
          ? (Number(
              dto.montoUsdAplicado != null
                ? dto.montoUsdAplicado
                : (dto.moneda === 'PEN'
                    ? Number(dto.monto) / Number((dto.tipoCambioDia != null ? dto.tipoCambioDia : 3.7))
                    : Number(dto.monto))
            ).toFixed(2) as any)
          : null,
    });

    const saved = await this.repo.save(gasto);

    // Auto-upsert de programación para gastos mensuales/recurrentes
    if (gasto.concepto === 'gastos_recurrentes') {
      try {
        const key = {
          userId,
          tipo: 'recurrente' as const,
          concepto: 'gastos_recurrentes',
          metodoPago,
          moneda,
          monto: Number(dto.monto).toFixed(2),
          tarjeta: metodoPago === 'credito' ? (dto.tarjeta ?? null) : null,
          tarjetaPago: metodoPago === 'debito' ? (dto.tarjetaPago ?? null) : null,
        };

        const existing = await this.schedulesRepo.findOne({
          where: {
            userId: key.userId,
            tipo: key.tipo,
            concepto: key.concepto,
            metodoPago: key.metodoPago as any,
            moneda: key.moneda as any,
            monto: key.monto as any,
            tarjeta: key.tarjeta as any,
            tarjetaPago: key.tarjetaPago as any,
          },
        });

        if (!existing) {
          const sc = this.schedulesRepo.create({
            userId: key.userId,
            tipo: 'recurrente',
            concepto: key.concepto,
            metodoPago: key.metodoPago as any,
            moneda: key.moneda as any,
            monto: key.monto as any,
            nextDate: this.addMonth(dto.fecha),
            lastDate: dto.fecha,
            remaining: null,
            tarjeta: key.tarjeta as any,
            tarjetaPago: key.tarjetaPago as any,
            active: true,
          });
          await this.schedulesRepo.save(sc);
        } else {
          existing.lastDate = dto.fecha;
          if (!existing.nextDate || existing.nextDate <= dto.fecha) {
            existing.nextDate = this.addMonth(dto.fecha);
          }
          existing.active = true;
          await this.schedulesRepo.save(existing);
        }
      } catch {
        // No bloquear la creación del gasto si falla schedules
      }
    }

    return saved;
  }

  findAllByUser(userId: number) {
    return this.repo.find({ where: { userId }, order: { fecha: 'DESC', id: 'DESC' } });
  }

  private normalizeBudgetMonth(month?: string) {
    const value = String(month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(value)) {
      throw new BadRequestException('Mes invalido. Usa formato YYYY-MM.');
    }
    return value;
  }

  private resolveBudgetUserId(userId: number, role: Role, targetUserId?: number) {
    if (role === 'admin' && targetUserId && Number.isFinite(targetUserId) && targetUserId > 0) {
      return targetUserId;
    }
    return userId;
  }

  async getBudget(userId: number, role: Role, month: string, targetUserId?: number) {
    const budgetMonth = this.normalizeBudgetMonth(month);
    const budgetUserId = this.resolveBudgetUserId(userId, role, targetUserId);
    const row = await this.budgetsRepo.findOne({ where: { userId: budgetUserId, month: budgetMonth } });
    return {
      userId: budgetUserId,
      month: budgetMonth,
      amount: Number(row?.amount || 0),
    };
  }

  async upsertBudget(userId: number, role: Role, dto: UpsertGastoBudgetDto, targetUserId?: number) {
    const budgetMonth = this.normalizeBudgetMonth(dto.month);
    const budgetUserId = this.resolveBudgetUserId(userId, role, targetUserId ?? dto.userId);
    const amount = Math.max(0, Number(dto.amount) || 0);
    let row = await this.budgetsRepo.findOne({ where: { userId: budgetUserId, month: budgetMonth } });
    if (!row) {
      row = this.budgetsRepo.create({
        userId: budgetUserId,
        month: budgetMonth,
        amount: amount.toFixed(2),
      });
    } else {
      row.amount = amount.toFixed(2);
    }
    const saved = await this.budgetsRepo.save(row);
    return {
      userId: saved.userId,
      month: saved.month,
      amount: Number(saved.amount || 0),
    };
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
    if (dto.detalleGusto !== undefined && dto.notas === undefined) {
      g.notas = dto.detalleGusto ?? null;
    }
    if (dto.cuotasMeses !== undefined) g.cuotasMeses = dto.cuotasMeses ?? null;
    if (dto.monto !== undefined) g.monto = Number(dto.monto).toFixed(2);
    if (dto.fecha !== undefined) g.fecha = dto.fecha;

    if (dto.metodoPago !== undefined) g.metodoPago = dto.metodoPago === 'credito' ? ('credito' as any) : ('debito' as any);

    if (dto.moneda !== undefined) {
      g.moneda = dto.moneda === 'USD' ? ('USD' as any) : ('PEN' as any);
    }

    if (dto.concepto !== undefined || dto.metodoPago !== undefined) {
      if (!(await this.isConceptAllowed(g.concepto, g.metodoPago))) {
        throw new BadRequestException(`Concepto no permitido para ${g.metodoPago}`);
      }
    }

    if (dto.tarjeta !== undefined) g.tarjeta = dto.tarjeta ?? null;

    if (g.concepto === 'pago_tarjeta' && g.metodoPago === 'debito') {
      if (dto.tarjetaPago !== undefined) g.tarjetaPago = dto.tarjetaPago ?? null;
    } else {
      g.tarjetaPago = null;
    }

    if (dto.notas !== undefined) g.notas = dto.notas ?? null;

    // Si el concepto es cashback, forzamos monto negativo
    if (g.concepto === 'cashback' && dto.monto !== undefined) {
      g.monto = (-Math.abs(Number(dto.monto))).toFixed(2);
    } else if (dto.monto !== undefined) {
      g.monto = Number(dto.monto).toFixed(2);
    }

    return this.repo.save(g);
  }

  async remove(userId: number, role: Role, id: number) {
    const g = await this.getOrThrow(id);
    if (role !== 'admin' && g.userId !== userId) throw new ForbiddenException('No autorizado');
    await this.repo.remove(g);
    return { ok: true };
  }
}


