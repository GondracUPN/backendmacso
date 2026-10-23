import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  Optional,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, ILike, In, IsNull, Like, Not, Repository } from 'typeorm';
import { Venta } from './venta.entity';
import { VentaAdelanto, VentaAdelantoCuota } from './venta-adelanto.entity';
import { CreateVentaDto } from './dto/create-venta.dto';
import { UpdateVentaDto } from './dto/update-venta.dto';
import { CreateVentaAdelantoDto } from './dto/create-venta-adelanto.dto';
import { CompleteVentaAdelantoDto } from './dto/complete-venta-adelanto.dto';
import { AddVentaAdelantoCuotaDto } from './dto/add-venta-adelanto-cuota.dto';
import { isAccessoryStock } from '../producto/accessory-rules';
import { Producto } from '../producto/producto.entity';
import { ProductoValor } from '../producto/producto-valor.entity';
import { calculateProfitPercentage } from './venta-profit.utils';
import { Gasto } from '../gastos/entities/gasto.entity';
import { reservaActivaSql, reservaActivaWhere } from './estado-comercial';
import { VentaDevolucion } from './venta-devolucion.entity';
import { DevolverVentaDto } from './dto/devolver-venta.dto';
import { VentaPago } from '../finanzas/entities/venta-pago.entity';
import { resumenPago } from '../finanzas/finanzas-calc';
import { toPagoCalc } from '../finanzas/finanzas-ledger.service';
import { ConflictException } from '@nestjs/common';
import { operationHash } from './operation-hash';
import { costoEnSoles } from './costo-en-soles';
import { CuentaFinanciera } from '../finanzas/entities/cuenta-financiera.entity';
import { User } from '../auth/entities/user.entity';
import { formatAppleWatchName } from '../common/product-name.util';
import { FinanzasLedgerService } from '../finanzas/finanzas-ledger.service';
import { toCents } from '../finanzas/finanzas-calc';

const normalizeSeller = (s?: string | null) =>
  s == null ? '' : String(s).trim().toLowerCase();
const normalizeComparable = (value?: string | number | null) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9.]+/g, '');
const daysBetweenDates = (from?: string | null, to?: string | null) => {
  if (!from || !to) return null;
  const start = new Date(from);
  const end = new Date(to);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  const days = Math.round((end.getTime() - start.getTime()) / 86400000);
  return days >= 0 ? days : null;
};
const isSplitSeller = (s?: string | null) => normalizeSeller(s) === 'ambos';
const titleCaseName = (value?: string | null) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((part) =>
      part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : '',
    )
    .join(' ');
const normalizeSellerLabel = (s?: string | null): string | null => {
  const slug = normalizeSeller(s);
  if (slug === 'gonzalo') return 'Gonzalo';
  if (slug === 'renato') return 'Renato';
  if (slug === 'ambos') return 'ambos';
  const requestMatch = String(s || '').trim().match(/^gonzalo\s*\(([^)]+)\)$/i);
  if (requestMatch?.[1]) {
    const client = titleCaseName(requestMatch[1]);
    return client ? `Gonzalo (${client})` : null;
  }
  return null;
};
const sellerFromProducto = (producto?: Producto | null, fallback?: string | null) =>
  normalizeSellerLabel((producto as any)?.vendedor ?? fallback);
const getPedidoClient = (seller?: string | null) => {
  const match = String(seller || '').trim().match(/^gonzalo\s*\(([^)]+)\)$/i);
  return match?.[1] ? titleCaseName(match[1]) : null;
};
const toMoneyNumber = (value: any) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const getProductCost = (producto?: Producto | null) => {
  const valor = (producto as any)?.valor || {};
  return toMoneyNumber(
    valor.costoTotalProrrateado ?? valor.costoTotal ?? valor.valorSoles,
  );
};
const getAccessoryUnitCost = (producto?: Producto | null) =>
  getProductCost(producto) / Math.max(1, Number(producto?.stockInicial || 1));
const getAccessoryLotDate = (producto?: Producto | null) => {
  const purchase = (producto as any)?.valor?.fechaCompra;
  const purchaseTime = purchase ? new Date(purchase).getTime() : NaN;
  if (Number.isFinite(purchaseTime)) return purchaseTime;
  const tracking = Array.isArray((producto as any)?.tracking)
    ? (producto as any).tracking
    : [];
  const pickupDates = tracking
    .map((row: any) => row?.fechaRecogido || (String(row?.estado || '').toLowerCase() === 'recogido' ? row?.createdAt : null))
    .filter(Boolean)
    .map((value: any) => new Date(value).getTime())
    .filter(Number.isFinite);
  if (pickupDates.length) return Math.min(...pickupDates);
  return Number((producto as any)?.id || 0);
};
const accessoryFamily = (detail: any): string => {
  const value = normalizeComparable([
    detail?.modelo,
    detail?.gama,
    detail?.descripcionOtro,
  ].filter(Boolean).join(' '));
  if (!value) return '';
  if (value.includes('airtag')) return 'airtag';
  if (value.includes('applepencil') || value.includes('pencil')) return 'apple-pencil';
  if (value.includes('magickeyboard')) return 'magic-keyboard';
  if (value.includes('charger') || value.includes('cargador') || value.includes('adaptador') || value.includes('cubo')) return 'cargador';
  if (value.includes('cable')) return 'cable';
  if (value.includes('case') || value.includes('funda')) return 'case';
  if (value.includes('correa') || value.includes('band')) return 'correa';
  if (value.includes('mica') || value.includes('protector')) return 'protector';
  if (value.includes('teclado') || value.includes('keyboard')) return 'teclado';
  if (value.includes('mouse') || value.includes('raton')) return 'mouse';
  return value
    .replace(/\b(?:1st|2nd|3rd|first|second|third|primera|segunda|tercera|1a|2a|3a)\s+(?:generation|generacion)\b/g, '')
    .replace(/\b(?:pro|usb c)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};
const buildProductoNombre = (producto?: Producto | null) => {
  if (!producto) return '-';
  const detalle = (producto as any).detalle || {};
  const tipo = String((producto as any).tipo || '').trim();
  const tipoLower = tipo.toLowerCase();
  if (tipoLower === 'otro') return detalle.descripcionOtro || 'Otros';
  if (tipoLower === 'iphone') {
    return ['iPhone', detalle.numero, detalle.modelo].filter(Boolean).join(' ');
  }
  if (tipoLower === 'watch') {
    return formatAppleWatchName(detalle);
  }
  return [
    tipo,
    detalle.gama,
    detalle.procesador,
    detalle.tamano || detalle['tamaño'] || detalle.tamanio,
    detalle.almacenamiento,
  ]
    .filter(Boolean)
    .join(' ');
};
const buildMoneyStats = (saleAmount: number, costAmount: number) => {
  const ganancia = +(saleAmount - costAmount).toFixed(2);
  const utilidadPct = saleAmount ? +((ganancia / saleAmount) * 100).toFixed(2) : 0;
  const markupPct = costAmount ? +((ganancia / costAmount) * 100).toFixed(2) : 0;
  return { ganancia, utilidadPct, markupPct };
};
const getLatestTracking = (producto?: Producto | null) => {
  const tracking = Array.isArray((producto as any)?.tracking)
    ? [...((producto as any).tracking || [])]
    : [];
  tracking.sort((a, b) => {
    const at = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bt = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (at !== bt) return bt - at;
    return Number(b?.id || 0) - Number(a?.id || 0);
  });
  return tracking[0] || null;
};
const getPedidoStatus = (
  producto: Producto | null | undefined,
  payment: 'pagado' | 'adelanto' | 'sin_pago',
) => {
  const latestTracking = getLatestTracking(producto);
  const trackingEstado = String(latestTracking?.estado || '').toLowerCase();
  const recogido =
    trackingEstado === 'recogido' || Boolean((latestTracking as any)?.fechaRecogido);
  if (payment === 'pagado') {
    return {
      estadoPago: 'pagado',
      estadoPedido: recogido ? 'cancelado_entregado' : 'cancelado_en_camino',
      trackingEstado,
      latestTracking,
    };
  }
  if (payment === 'adelanto') {
    return {
      estadoPago: 'adelanto',
      estadoPedido: recogido ? 'recogido_con_adelanto' : 'en_camino_con_adelanto',
      trackingEstado,
      latestTracking,
    };
  }
  return {
    estadoPago: 'sin_pago',
    estadoPedido: recogido ? 'recogido_sin_pago' : 'en_camino_sin_pago',
    trackingEstado,
    latestTracking,
  };
};

const calcSplitCosts = (valor: ProductoValor, envioSoles: number, tcG: number, tcR: number) => {
  const costoG = +(costoEnSoles(valor, tcG) / 2 + envioSoles / 2).toFixed(2);
  const costoR = +(costoEnSoles(valor, tcR) / 2 + envioSoles / 2).toFixed(2);
  return { total: +(costoG + costoR).toFixed(2), valorSoles: +((costoEnSoles(valor, tcG) + costoEnSoles(valor, tcR)) / 2).toFixed(2) };
};

const isAdvanceIncome = (row: Pick<Gasto, 'notas'>) => String(row.notas || '').startsWith('__SALE_ADVANCE__:');

const advanceOwners = (vendedor?: string | null): Array<'gonzalo' | 'renato'> => {
  const seller = normalizeSeller(vendedor);
  return seller === 'ambos'
    ? ['gonzalo', 'renato']
    : seller === 'renato' ? ['renato']
      : seller === 'gonzalo' || seller.startsWith('gonzalo (') ? ['gonzalo'] : [];
};

// 👇 filtros para listar ventas (export opcional)
export type ListVentasParams = {
  from?: string; // 'YYYY-MM-DD'
  to?: string; // 'YYYY-MM-DD'
  unassigned?: boolean; // ventas cuyo producto no tiene vendedor
  productoId?: number; // opcional
  vendedor?: string; // Gonzalo | Renato, incluye ventas compartidas
};

@Injectable()
export class VentaService {
  private transactionManager?: EntityManager;

  // Cada operación usa su propia instancia y los repositorios de la transacción.
  // El ledger recibe el mismo manager para que sus escrituras también se reviertan.
  private async inTransaction<T>(work: (service: VentaService) => Promise<T>): Promise<T> {
    if (this.transactionManager) return work(this);
    return this.adelantoRepo.manager.transaction(async (manager) => {
      const scoped = this.conManager(manager);
      return work(scoped);
    });
  }

  conManager(manager: EntityManager): VentaService {
      const scoped = new VentaService(
        manager.getRepository(Venta), manager.getRepository(VentaAdelanto),
        manager.getRepository(Producto), manager.getRepository(ProductoValor), this.cache,
        this.gastoRepo ? manager.getRepository(Gasto) : undefined,
        this.userRepo ? manager.getRepository(User) : undefined, this.ledger,
      );
      scoped.transactionManager = manager;
      return scoped;
  }

  constructor(
    @InjectRepository(Venta) private readonly ventaRepo: Repository<Venta>,
    @InjectRepository(VentaAdelanto)
    private readonly adelantoRepo: Repository<VentaAdelanto>,
    @InjectRepository(Producto)
    private readonly productoRepo: Repository<Producto>,
    @InjectRepository(ProductoValor)
    private readonly valorRepo: Repository<ProductoValor>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    @Optional() @InjectRepository(Gasto)
    private readonly gastoRepo?: Repository<Gasto>,
    @Optional() @InjectRepository(User)
    private readonly userRepo?: Repository<User>,
    @Optional() private readonly ledger?: FinanzasLedgerService,
  ) {}

  private async resolveIncomeUser(owner: 'gonzalo' | 'renato'): Promise<User | null> {
    if (!this.userRepo) return null;
    const cached = this.incomeUsers.get(owner);
    if (cached && cached.until > Date.now()) return cached.value;
    const value = (async () => {
      const named = await this.userRepo!.findOne({ where: { username: ILike(`%${owner}%`) } });
      if (named) return named;
      return owner === 'gonzalo' ? this.userRepo!.findOne({ where: { role: 'admin' } }) : null;
    })();
    this.incomeUsers.set(owner, { until: Date.now() + 10_000, value });
    try { return await value; } catch (error) { this.incomeUsers.delete(owner); throw error; }
  }

  private readonly incomeUsers = new Map<string, { until: number; value: Promise<User | null> }>();

  /** Reparacion manual, paginada y secuencial; nunca se invoca desde un GET. */
  async backfillAdelantoIncome(apply = false): Promise<{ active: number; synchronized: number }> {
    const where = { completadoAt: IsNull(), canceladoAt: IsNull() };
    const active = await this.adelantoRepo.count({ where });
    if (!apply) return { active, synchronized: 0 };
    let synchronized = 0;
    for (let skip = 0; skip < active; skip += 100) {
      const items = await this.adelantoRepo.find({ where, relations: ['producto'], order: { id: 'ASC' }, skip, take: 100 });
      for (const item of items) {
        await this.inTransaction(async (service) => {
          const current = await service.findAdelanto(item.id);
          if (!current.canceladoAt && !current.completadoAt) await service.syncAdelantoIncome(current, item.producto);
        });
        synchronized++;
      }
    }
    return { active, synchronized };
  }

  private async syncAdelantoIncome(adelanto: VentaAdelanto, producto?: Producto | null): Promise<void> {
    await this.syncAdelantoIncomeRows(adelanto, producto);
    // El libro de pagos deriva los adelantos de las mismas cuotas, sin duplicarlas.
    if (adelanto?.id) await this.ledger?.sincronizarAdelanto(adelanto.id, this.transactionManager);
  }

  private async syncAdelantoIncomeRows(adelanto: VentaAdelanto, producto?: Producto | null): Promise<void> {
    if (!this.gastoRepo || !this.userRepo) return;
    const owners = advanceOwners(producto?.vendedor || adelanto.producto?.vendedor);
    const cuotas = Array.isArray(adelanto.cuotas) && adelanto.cuotas.length
      ? adelanto.cuotas
      : [{ fecha: adelanto.fechaAdelanto, monto: Number(adelanto.montoAdelanto) }];
    for (const [index, cuota] of cuotas.entries()) {
      const cents = Math.round(Number(cuota.monto) * 100);
      if (cents <= 0) continue;
      const reference = `__SALE_ADVANCE__:${adelanto.id}:${index}`;
      const linked = await this.gastoRepo.find({ where: { concepto: 'ingreso', metodoPago: 'debito', notas: reference } });
      let allocated = 0;
      for (const [ownerIndex, owner] of owners.entries()) {
        const user = await this.resolveIncomeUser(owner);
        if (!user?.id) throw new BadRequestException(`No se encontró el usuario ${owner} para registrar el adelanto.`);
        const ownerCents = ownerIndex === owners.length - 1 ? cents - allocated : Math.round(cents / owners.length);
        allocated += ownerCents;
        if (ownerCents <= 0) continue;
        const existing = linked.find((row) => row.userId === user.id);
        const tipoPago = cuota.tipoPago || 'direct';
        if (!existing && !cuota.banco && !cuota.tipoPago) {
          const manualMatches = await this.gastoRepo.find({ where: {
            userId: user.id, concepto: 'ingreso', metodoPago: 'debito', moneda: 'PEN',
            fecha: cuota.fecha, monto: (ownerCents / 100).toFixed(2),
          } });
          if (manualMatches.filter((row) => !row.saleId && !String(row.notas || '').startsWith('__SALE_')).length === 1) continue;
        }
        const received = tipoPago === 'direct' ? ownerCents : Math.round(Number(existing?.saleReceivedAmount || 0) * 100);
        if (received > ownerCents) throw new BadRequestException('El adelanto es menor que los pagos ya recibidos.');
        const values = {
          userId: user.id,
          concepto: 'ingreso',
          metodoPago: 'debito' as const,
          moneda: 'PEN' as const,
          monto: (ownerCents / 100).toFixed(2),
          montoPen: (ownerCents / 100).toFixed(2),
          fecha: cuota.fecha,
          tarjeta: cuota.banco || existing?.tarjeta || 'bcp',
          tarjetaPago: null,
          notas: reference,
          saleId: adelanto.ventaId || null,
          saleSku: `MS-${producto?.codigoInventario || adelanto.productoId}`,
          salePaymentType: tipoPago,
          saleReceivedAmount: (received / 100).toFixed(2),
          salePaidAt: tipoPago === 'direct' ? cuota.fecha : (existing?.salePaidAt || null),
          salePaymentHistory: existing?.salePaymentHistory || null,
          cantidad500: null,
        };
        await this.gastoRepo.save(existing ? Object.assign(existing, values) : this.gastoRepo.create(values));
      }
    }
  }

  private async syncSaleIncome(
    venta: Venta, incomeBank?: string, paymentType?: 'direct' | 'card' | 'debt', saleSku?: string,
    submittedParts?: Array<{ type: 'direct' | 'card' | 'debt' | 'cash'; amount: number }>,
    destination?: { cuentaId?: number; metodo?: string },
  ): Promise<void> {
    if (destination?.cuentaId) {
      const cuenta = await this.transactionManager!.getRepository(CuentaFinanciera).findOneBy({ id: destination.cuentaId });
      if (!cuenta?.activo || !['banco', 'billetera', 'efectivo', 'procesador', 'tercero'].includes(cuenta.tipo) || cuenta.moneda !== 'PEN') {
        throw new BadRequestException('Selecciona una cuenta activa en soles compatible con el cobro.');
      }
      if (destination.metodo === 'tarjeta' && cuenta.tipo !== 'procesador'
        || destination.metodo === 'efectivo' && !['efectivo', 'tercero'].includes(cuenta.tipo)
        || ['transferencia', 'yape', 'plin', 'deposito'].includes(destination.metodo || '') && !['banco', 'billetera', 'tercero'].includes(cuenta.tipo)) {
        throw new BadRequestException('El método de cobro no corresponde a la cuenta.');
      }
      incomeBank = cuenta.legacyCodigo || cuenta.codigo;
    }
    await this.syncSaleIncomeRows(venta, incomeBank, paymentType, saleSku, submittedParts, destination);
    if (venta?.id && this.ledger) {
      const advance = submittedParts === undefined && paymentType && typeof this.adelantoRepo?.findOne === 'function'
        ? await this.adelantoRepo.findOne({ where: { ventaId: venta.id } }) : null;
      const parts = submittedParts ?? (paymentType
        ? [{ type: paymentType, amount: (toCents(venta.precioVenta) - toCents(advance?.montoAdelanto)) / 100 }]
        : undefined);
      await this.ledger.sincronizarIngresosVenta(venta.id, this.transactionManager, { parts: parts?.filter((part) => toCents(part.amount) > 0), incomeBank, cuentaId: destination?.cuentaId, metodo: destination?.metodo });
    }
  }

  private async syncSaleIncomeRows(
    venta: Venta, incomeBank?: string, paymentType?: 'direct' | 'card' | 'debt', saleSku?: string,
    submittedParts?: Array<{ type: 'direct' | 'card' | 'debt' | 'cash'; amount: number }>,
    destination?: { cuentaId?: number; metodo?: string },
  ): Promise<void> {
    if (!this.gastoRepo || !this.userRepo) return;
    const seller = normalizeSeller(venta.vendedor);
    const owners: Array<{ owner: 'gonzalo' | 'renato'; share: number }> = seller === 'ambos'
      ? [{ owner: 'gonzalo', share: 0.5 }, { owner: 'renato', share: 0.5 }]
      : seller === 'renato'
        ? [{ owner: 'renato', share: 1 }]
        : seller === 'gonzalo' || seller.startsWith('gonzalo (')
          ? [{ owner: 'gonzalo', share: 1 }]
          : [];
    if (!owners.length) return;

    // El ID de venta mantiene cada cobro unido a su venta, incluso con varias salidas del mismo producto.
    const reference = `__SALE_INCOME__:${venta.productoId}:${venta.id}`;
    const legacyReference = `__SALE_INCOME__:${venta.productoId}`;
    // Las filas de adelanto también llevan sale_id al completarse, pero las gestiona la reserva.
    const linked = (await this.gastoRepo.find({
      where: [
        { saleId: venta.id, concepto: 'ingreso', metodoPago: 'debito' },
        { saleId: IsNull(), concepto: 'ingreso', metodoPago: 'debito', notas: In([
          legacyReference, String(venta.productoId), ...(['direct', 'card', 'debt', 'cash'].map((type) => `${legacyReference}:${type}`)),
        ]) },
      ],
      order: { id: 'ASC' },
    })).filter((row) => !isAdvanceIncome(row));
    const completedAdelanto = typeof this.adelantoRepo?.findOne === 'function'
      ? await this.adelantoRepo.findOne({ where: { ventaId: venta.id } })
      : null;
    const totalCents = Math.round(Number(venta.precioVenta || 0) * 100)
      - Math.round(Number(completedAdelanto?.montoAdelanto || 0) * 100);
    if (totalCents < 0) throw new BadRequestException('El precio de venta no puede ser menor que los adelantos registrados.');
    if (totalCents === 0) {
      if (linked.length) await this.gastoRepo.remove(linked);
      return;
    }
    let parts: Array<{ type: 'direct' | 'card' | 'debt' | 'cash'; cents: number }> | null = null;
    const hasPartReference = (row: Gasto) => ['direct', 'card', 'debt', 'cash']
      .some((type) => String(row.notas || '').endsWith(`:${type}`));
    const keepRowBanks = submittedParts === undefined && linked.some(hasPartReference);
    if (keepRowBanks) {
      submittedParts = (['direct', 'card', 'debt', 'cash'] as const).map((type) => ({
        type,
        amount: linked.filter((row) => row.salePaymentType === type).reduce((sum, row) => sum + Number(row.monto || 0), 0),
      })).filter((part) => part.amount > 0);
      // Las partes ya registradas conservan la cuenta donde se cobraron.
      incomeBank = incomeBank || linked.find((row) => row.tarjeta && row.tarjeta !== 'efectivo')?.tarjeta || undefined;
    }
    if (submittedParts !== undefined) {
      if (!Array.isArray(submittedParts) || !submittedParts.length) throw new BadRequestException('Indica al menos una forma de cobro.');
      const seen = new Set<string>();
      parts = submittedParts.map((part) => {
        const cents = Math.round(Number(part.amount) * 100);
        if (!['direct', 'card', 'debt', 'cash'].includes(part.type) || seen.has(part.type)
          || !Number.isSafeInteger(cents) || cents <= 0 || Math.abs(cents / 100 - Number(part.amount)) > 0.000001) {
          throw new BadRequestException('Las partes del cobro deben tener tipos distintos y montos válidos.');
        }
        seen.add(part.type);
        return { type: part.type, cents };
      });
      if (parts.reduce((sum, part) => sum + part.cents, 0) !== totalCents) {
        throw new BadRequestException('Las partes del cobro deben sumar el precio total de la venta.');
      }
      if (parts.some((part) => part.type !== 'cash') && !incomeBank) {
        throw new BadRequestException('Selecciona la cuenta de débito para el cobro que no es en efectivo.');
      }
      const receivedByType = new Map<string, number>();
      linked.forEach((row) => {
        if (row.salePaymentType) receivedByType.set(row.salePaymentType,
          (receivedByType.get(row.salePaymentType) || 0) + Math.round(Number(row.saleReceivedAmount || 0) * 100));
      });
      for (const [type, received] of receivedByType) {
        if (type !== 'card' && type !== 'debt') continue;
        if (received > (parts.find((part) => part.type === type)?.cents || 0)) {
          throw new BadRequestException('El nuevo importe no puede ser menor que los pagos ya recibidos.');
        }
      }
    }
    const desiredIds = new Set<number>();
    const allocatedPartCents = new Map<string, number>();

    let allocatedOwnerCents = 0;
    for (const [ownerIndex, { owner, share }] of owners.entries()) {
      const user = await this.resolveIncomeUser(owner);
      if (!user?.id) throw new BadRequestException(`No se encontró el usuario ${owner} para registrar el ingreso.`);
      const ownerCents = ownerIndex === owners.length - 1 ? totalCents - allocatedOwnerCents : Math.round(totalCents * share);
      allocatedOwnerCents += ownerCents;
      const amount = ownerCents / 100;
      if (parts) {
        for (const part of parts) {
          const previousAllocation = allocatedPartCents.get(part.type) || 0;
          const partCents = ownerIndex === owners.length - 1
            ? part.cents - previousAllocation
            : Math.round(part.cents * share);
          allocatedPartCents.set(part.type, previousAllocation + partCents);
          if (partCents <= 0) continue;
          const partReference = `${reference}:${part.type}`;
          const existingPart = linked.find((row) => row.userId === user.id && row.salePaymentType === part.type);
          const isReceived = part.type === 'direct' || part.type === 'cash';
          const values = {
            userId: user.id,
            concepto: 'ingreso',
            metodoPago: 'debito' as const,
            moneda: 'PEN' as const,
            monto: (partCents / 100).toFixed(2),
            montoPen: (partCents / 100).toFixed(2),
            fecha: String(venta.fechaVenta || '').slice(0, 10),
            tarjeta: part.type === 'cash' ? 'efectivo' : (keepRowBanks && existingPart?.tarjeta) || incomeBank || existingPart?.tarjeta || 'bcp',
            tarjetaPago: null,
            notas: partReference,
            saleId: venta.id,
            saleCuentaId: destination?.cuentaId || existingPart?.saleCuentaId || null,
            saleMetodo: destination?.metodo || existingPart?.saleMetodo || null,
            saleSku: saleSku || existingPart?.saleSku || null,
            salePaymentType: part.type,
            saleReceivedAmount: isReceived ? (partCents / 100).toFixed(2) : (existingPart?.saleReceivedAmount || '0.00'),
            salePaidAt: isReceived ? String(venta.fechaVenta || '').slice(0, 10) : (existingPart?.salePaidAt || null),
            cantidad500: part.type === 'debt' ? (existingPart?.cantidad500 || 0) : null,
          };
          const saved = await this.gastoRepo.save(existingPart ? Object.assign(existingPart, values) : this.gastoRepo.create(values));
          if (saved?.id) desiredIds.add(saved.id);
        }
        continue;
      }
      const existing = linked.find((row) => row.userId === user.id && !hasPartReference(row));
      const resolvedPaymentType = paymentType || existing?.salePaymentType || null;
      const samePaymentType = existing?.salePaymentType === resolvedPaymentType;
      if (samePaymentType && Number(existing?.saleReceivedAmount || 0) > amount) {
        throw new BadRequestException('El saldo de venta es menor que los pagos ya recibidos.');
      }
      const values = {
        userId: user.id,
        concepto: 'ingreso',
        metodoPago: 'debito' as const,
        moneda: 'PEN' as const,
        monto: amount.toFixed(2),
        montoPen: amount.toFixed(2),
        fecha: String(venta.fechaVenta || '').slice(0, 10),
        tarjeta: incomeBank || existing?.tarjeta || 'bcp',
        tarjetaPago: null,
        notas: reference,
        saleId: venta.id,
        saleCuentaId: destination?.cuentaId || existing?.saleCuentaId || null,
        saleMetodo: destination?.metodo || existing?.saleMetodo || null,
        saleSku: saleSku || existing?.saleSku || null,
        salePaymentType: resolvedPaymentType,
        saleReceivedAmount: resolvedPaymentType === 'direct'
          ? amount.toFixed(2)
          : samePaymentType ? (existing?.saleReceivedAmount ?? (resolvedPaymentType ? '0.00' : null)) : (resolvedPaymentType ? '0.00' : null),
        salePaidAt: resolvedPaymentType === 'direct'
          ? String(venta.fechaVenta || '').slice(0, 10)
          : samePaymentType ? (existing?.salePaidAt ?? null) : null,
        cantidad500: resolvedPaymentType === 'debt' ? (samePaymentType ? (existing?.cantidad500 ?? 0) : 0) : null,
      };
      if (existing) {
        Object.assign(existing, values);
        const saved = await this.gastoRepo.save(existing);
        if (saved?.id) desiredIds.add(saved.id);
      } else {
        const saved = await this.gastoRepo.save(this.gastoRepo.create(values));
        if (saved?.id) desiredIds.add(saved.id);
      }
    }

    const obsolete = linked.filter((row) => !desiredIds.has(row.id));
    if (obsolete.length) await this.gastoRepo.remove(obsolete);
  }

  async updateSaleIncomePayment(
    gastoId: number,
    input: { paymentAmount?: number; paymentCount?: number; paidAt?: string; exchangeRate?: number; bank?: string },
  ): Promise<Gasto> {
    if (!this.gastoRepo) throw new BadRequestException('No se pueden actualizar los cobros.');
    const income = await this.gastoRepo.findOne({ where: { id: gastoId } });
    const isAdvance = String(income?.notas || '').startsWith('__SALE_ADVANCE__:');
    if (!income || (!income.saleId && !isAdvance) || !['card', 'debt'].includes(String(income.salePaymentType))) {
      throw new BadRequestException('Este ingreso no corresponde a un cobro de venta del catálogo.');
    }
    const totalCents = Math.round(Number(income.monto) * 100);
    const receivedCents = Math.round(Number(income.saleReceivedAmount || 0) * 100);
    const remainingCents = totalCents - receivedCents;
    const hasAmount = input.paymentAmount !== undefined;
    const hasCount = input.paymentCount !== undefined;
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0 || !Number.isSafeInteger(receivedCents) || receivedCents < 0 || remainingCents < 0) {
      throw new BadRequestException('El saldo de la venta es inválido.');
    }
    if (hasAmount && hasCount) throw new BadRequestException('Registra el pago en un solo formato.');
    if (!hasAmount && !hasCount && input.exchangeRate === undefined) throw new BadRequestException('Indica un pago o un tipo de cambio.');

    let paymentCents = 0;
    if (hasCount) {
      if (income.salePaymentType !== 'debt' || !Number.isInteger(input.paymentCount) || input.paymentCount! < 1 || remainingCents < 50000) {
        throw new BadRequestException('La cantidad de pagos de S/ 500 es inválida.');
      }
      paymentCents = input.paymentCount! * 50000;
    } else if (hasAmount) {
      const amount = Number(input.paymentAmount);
      paymentCents = Math.round(amount * 100);
      if (!Number.isFinite(amount) || paymentCents < 1 || Math.abs(paymentCents / 100 - amount) > 0.000001) {
        throw new BadRequestException('Ingresa un monto recibido válido.');
      }
      if (income.salePaymentType === 'debt' && remainingCents >= 50000) {
        throw new BadRequestException('Registra primero los pagos de S/ 500.');
      }
    }
    if (paymentCents > remainingCents) throw new BadRequestException('El pago supera el saldo pendiente.');
    if (paymentCents > 0 && (!input.paidAt || !/^\d{4}-\d{2}-\d{2}$/.test(input.paidAt))) {
      throw new BadRequestException('Indica la fecha del pago.');
    }
    if (!paymentCents && input.paidAt) throw new BadRequestException('Registra un monto antes de indicar la fecha.');
    const bank = input.bank ? String(input.bank).trim().toLowerCase() : '';
    if (bank && !/^[a-z0-9_]{2,30}$/.test(bank)) throw new BadRequestException('Cuenta de débito inválida.');
    if (input.exchangeRate !== undefined) {
      const rate = Number(input.exchangeRate);
      if (!Number.isFinite(rate) || rate <= 0) throw new BadRequestException('Tipo de cambio inválido.');
      income.saleExchangeRate = rate.toFixed(4);
    }
    const history = Array.isArray(income.salePaymentHistory) ? [...income.salePaymentHistory] : [];
    if (!history.length && receivedCents > 0) {
      history.push({ amount: receivedCents / 100, paidAt: income.salePaidAt || '', ...(income.salePaymentType === 'debt' ? { units500: Number(income.cantidad500 || 0) } : {}) });
    }
    if (paymentCents > 0) {
      history.push({ amount: paymentCents / 100, paidAt: input.paidAt!, ...(hasCount ? { units500: input.paymentCount } : {}), ...(bank ? { bank } : {}) });
    }
    const nextReceivedCents = receivedCents + paymentCents;
    income.salePaymentHistory = history;
    income.saleReceivedAmount = (nextReceivedCents / 100).toFixed(2);
    income.cantidad500 = income.salePaymentType === 'debt'
      ? history.reduce((sum, payment) => sum + Number(payment.units500 || 0), 0)
      : null;
    income.salePaidAt = history.at(-1)?.paidAt || null;
    if (income.saleExchangeRate) income.tasaUsdPen = income.saleExchangeRate;
    const savedIncome = await this.gastoRepo.save(income);
    if (savedIncome.saleId) await this.ledger?.sincronizarIngresosVenta(savedIncome.saleId);
    return savedIncome;
  }

  async getSalePayments(id: number) {
    const [sale, incomeRows, advance] = await Promise.all([
      this.findOne(id),
      this.gastoRepo ? this.gastoRepo.find({ where: { saleId: id, concepto: 'ingreso' } }) : Promise.resolve([]),
      typeof this.adelantoRepo?.findOne === 'function' ? this.adelantoRepo.findOne({ where: { ventaId: id } }) : Promise.resolve(null),
    ]);
    const incomes = incomeRows.filter((income) => !isAdvanceIncome(income));
    const types = ['direct', 'card', 'debt', 'cash'] as const;
    const parts = types.map((type) => ({
      type,
      amount: incomes.filter((income) => income.salePaymentType === type)
        .reduce((sum, income) => sum + Math.round(Number(income.monto || 0) * 100), 0) / 100,
      received: incomes.filter((income) => income.salePaymentType === type)
        .reduce((sum, income) => sum + Math.round(Number(income.saleReceivedAmount || 0) * 100), 0) / 100,
    })).filter((part) => part.amount > 0);
    return {
      saleId: sale.id,
      adelantoId: advance?.id || null,
      sku: incomes.find((income) => income.saleSku)?.saleSku || `MS-${sale.productoId}`,
      amount: Number(sale.precioVenta),
      advanceAmount: Number(advance?.montoAdelanto || 0),
      soldAt: String(sale.fechaVenta || '').slice(0, 10),
      exchangeRate: Number(sale.tipoCambio),
      incomeBank: incomes.find((income) => income.tarjeta && income.tarjeta !== 'efectivo')?.tarjeta || '',
      parts,
    };
  }

  async resultadoVenta(venta: Venta) {
    const rows = this.gastoRepo ? await this.gastoRepo.find({ where: { saleId: venta.id, concepto: 'ingreso' } }) : [];
    return { ...venta, ingreso: {
      estado: rows.length ? 'registrado' : 'sin_ingreso_asignado',
      monto: rows.reduce((sum, row) => sum + Number(row.monto), 0),
      cuentas: [...new Set(rows.map((row) => row.tarjeta).filter(Boolean))],
      ids: rows.map((row) => row.id),
    } };
  }

  private async findExistingByProducto(productoId: number): Promise<Venta | null> {
    return this.ventaRepo.findOne({
      where: { productoId, estadoComercial: Not('cancelada') },
      relations: ['producto'],
      order: { id: 'DESC' },
    });
  }

  private async saveIdempotent(venta: Venta): Promise<Venta> {
    try {
      return await this.ventaRepo.save(venta);
    } catch (error: any) {
      // PostgreSQL 23505: otra solicitud simultanea ya registro este producto.
      if (error?.code !== '23505' && error?.driverError?.code !== '23505') {
        throw error;
      }
      const existing = await this.findExistingByProducto(venta.productoId);
      if (existing) return existing;
      throw error;
    }
  }

  // Lista con filtros + joins para devolver producto, valor y detalle
  async findAll(params: ListVentasParams) {
    const qb = this.ventaRepo
      .createQueryBuilder('v')
      .leftJoinAndSelect('v.producto', 'p')
      .leftJoinAndSelect('p.valor', 'val')
      .leftJoinAndSelect('p.detalle', 'det');
    qb.andWhere('v."estadoComercial" <> :cancelada', { cancelada: 'cancelada' });

    if (params.productoId != null) {
      qb.andWhere('v.productoId = :pid', { pid: params.productoId });
    }
    if (params.from) {
      qb.andWhere('v.fechaVenta >= :from', { from: params.from });
    }
    if (params.to) {
      qb.andWhere('v.fechaVenta <= :to', { to: params.to });
    }
    if (params.unassigned) {
      qb.andWhere("(p.vendedor IS NULL OR p.vendedor = '')");
    }
    const vendedor = normalizeSeller(params.vendedor);
    if (vendedor) {
      if (vendedor === 'gonzalo') {
        qb.andWhere(
          "(LOWER(COALESCE(v.vendedor, p.vendedor, '')) = :vendedor OR LOWER(COALESCE(v.vendedor, p.vendedor, '')) = 'ambos' OR LOWER(COALESCE(v.vendedor, p.vendedor, '')) LIKE 'gonzalo (%)')",
          { vendedor },
        );
      } else {
        qb.andWhere(
          "(LOWER(COALESCE(v.vendedor, p.vendedor, '')) = :vendedor OR LOWER(COALESCE(v.vendedor, p.vendedor, '')) = 'ambos')",
          { vendedor },
        );
      }
    }

    const sales = await qb
      .orderBy('v.fechaVenta', 'DESC')
      .addOrderBy('v.id', 'DESC')
      .getMany();
    const accessorySales = sales.filter((sale) => isAccessoryStock(sale.producto?.tipo));
    if (!accessorySales.length) return sales;
    const ids = [...new Set(accessorySales.flatMap((sale) =>
      (sale.distribucionStock?.length ? sale.distribucionStock : [{ productoId: sale.productoId, cantidad: sale.cantidad || 1 }])
        .map((row) => Number(row.productoId)).filter(Boolean),
    ))];
    const lots = await this.productoRepo.find({ where: { id: In(ids) }, relations: ['valor'] });
    const byId = new Map(lots.map((lot) => [lot.id, lot]));
    for (const sale of accessorySales) {
      if (sale.costoPendiente) {
        sale.ganancia = null as any; sale.porcentajeGanancia = null as any; (sale as any).costoVendido = null;
        continue;
      }
      const distribution = sale.distribucionStock?.length
        ? sale.distribucionStock
        : [{ productoId: sale.productoId, cantidad: sale.cantidad || 1 }];
      const cost = distribution.reduce((sum, row) =>
        sum + Number(row.costoUnitario ?? getAccessoryUnitCost(byId.get(Number(row.productoId)))) * Number(row.cantidad || 0), 0);
      if (distribution.some((row) => row.costoUnitario == null && !byId.has(Number(row.productoId)))) continue;
      const profit = +(Number(sale.precioVenta) - cost + Number(sale.costoDevuelto || 0) - Number(sale.precioDevuelto || 0)).toFixed(2);
      sale.ganancia = profit;
      sale.porcentajeGanancia = calculateProfitPercentage(profit, cost);
      (sale as any).costoVendido = +(cost - Number(sale.costoDevuelto || 0)).toFixed(2);
    }
    return sales;
  }

  async findByProducto(productoId: number): Promise<Venta[]> {
    return this.ventaRepo.find({
      where: { productoId, estadoComercial: Not('cancelada') },
      order: { id: 'DESC' },
    });
  }

  async findSimilarSold(productoId: number, requestedLimit = 8): Promise<Array<Venta & {
    fechaIngresoAlmacen: string | null;
    diasHastaVenta: number | null;
  }>> {
    const reference = await this.productoRepo.findOne({
      where: { id: productoId },
      relations: ['detalle'],
    });
    if (!reference) throw new NotFoundException('Producto no encontrado');
    if (isAccessoryStock(reference.tipo) && reference.soloInventario) return [];

    const limit = Math.min(20, Math.max(1, Number(requestedLimit) || 8));
    const query = this.ventaRepo
      .createQueryBuilder('v')
      .leftJoinAndSelect('v.producto', 'p')
      .leftJoinAndSelect('p.detalle', 'det')
      .leftJoinAndSelect('p.tracking', 'trk')
      .where('LOWER(p.tipo) = LOWER(:tipo)', { tipo: reference.tipo });
    if (isAccessoryStock(reference.tipo)) query.andWhere('p.soloInventario = false');
    else query.andWhere('v.productoId <> :productoId', { productoId });
    const candidates = await query
      .orderBy('v.fechaVenta', 'DESC')
      .addOrderBy('v.id', 'DESC')
      .take(Math.max(50, limit * 10))
      .getMany();

    const referenceDetail: any = reference.detalle || {};
    const type = normalizeComparable(reference.tipo);
    const referenceAccessoryFamily = type === 'accesorios' ? accessoryFamily(referenceDetail) : '';
    const sameWhenPresent = (candidateDetail: any, key: string) => {
      const expected = normalizeComparable(referenceDetail[key]);
      return !expected || normalizeComparable(candidateDetail?.[key]) === expected;
    };

    const similar = candidates.filter((sale) => {
      const candidateDetail: any = sale.producto?.detalle || {};
      if (type === 'accesorios') {
        return Boolean(referenceAccessoryFamily)
          && accessoryFamily(candidateDetail) === referenceAccessoryFamily;
      }
      if (!sameWhenPresent(candidateDetail, 'procesador')) return false;
      if (!sameWhenPresent(candidateDetail, 'tamano')) return false;
      if (['macbook', 'ipad', 'watch'].includes(type) && !sameWhenPresent(candidateDetail, 'gama')) return false;
      if (type === 'ipad' && !normalizeComparable(referenceDetail.procesador) && !sameWhenPresent(candidateDetail, 'generacion')) return false;
      if (type === 'watch') {
        if (!sameWhenPresent(candidateDetail, 'generacion')) return false;
        if (!sameWhenPresent(candidateDetail, 'conexion')) return false;
      }
      if (type === 'iphone') {
        if (!sameWhenPresent(candidateDetail, 'numero')) return false;
        if (!sameWhenPresent(candidateDetail, 'modelo')) return false;
      }
      return true;
    }).slice(0, limit);

    return similar.map((sale) => {
      const pickupDates = (sale.producto?.tracking || [])
        .map((tracking) => tracking?.fechaRecogido)
        .filter((date): date is string => Boolean(date))
        .sort();
      const fechaIngresoAlmacen = pickupDates.length ? pickupDates[pickupDates.length - 1] : null;
      return Object.assign(sale, {
        fechaIngresoAlmacen,
        diasHastaVenta: daysBetweenDates(fechaIngresoAlmacen, sale.fechaVenta),
      });
    });
  }

  // Devuelve la Ð¥ltima venta por producto (opcionalmente filtrando por IDs) en una sola query
  async findLatestByProductos(productoIds?: number[]): Promise<Venta[]> {
    const qb = this.ventaRepo
      .createQueryBuilder('v')
      .distinctOn(['v.productoId'])
      .orderBy('v.productoId', 'ASC')
      .addOrderBy('v.fechaVenta', 'DESC')
      .addOrderBy('v.id', 'DESC');

    if (productoIds?.length) {
      qb.where('v.productoId IN (:...productoIds)', { productoIds });
    }

    qb.andWhere('v."estadoComercial" <> :cancelada', { cancelada: 'cancelada' });
    if (!productoIds?.length) qb.innerJoin(Producto, 'activeProduct', 'activeProduct.id = v.productoId AND activeProduct.archivadoAt IS NULL');
    return qb.getMany();
  }

  async findLatestAdelantosByProductos(productoIds?: number[]): Promise<VentaAdelanto[]> {
    const qb = this.adelantoRepo
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.producto', 'producto')
      .where(reservaActivaSql('a'))
      .distinctOn(['a.productoId'])
      .orderBy('a.productoId', 'ASC')
      .addOrderBy('a.createdAt', 'DESC')
      .addOrderBy('a.id', 'DESC');

    if (productoIds?.length) {
      qb.andWhere('a.productoId IN (:...productoIds)', { productoIds });
    }

    if (!productoIds?.length) qb.andWhere('producto."archivadoAt" IS NULL');
    return qb.getMany();
  }

  async pedidoSummary() {
    const ventas = await this.ventaRepo
      .createQueryBuilder('v')
      .leftJoinAndSelect('v.producto', 'p')
      .leftJoinAndSelect('p.valor', 'val')
      .leftJoinAndSelect('p.detalle', 'det')
      .leftJoinAndSelect('p.tracking', 'trk')
      .orderBy('v.fechaVenta', 'DESC')
      .addOrderBy('v.id', 'DESC')
      .getMany();

    const adelantos = await this.adelantoRepo
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.producto', 'p')
      .leftJoinAndSelect('p.valor', 'val')
      .leftJoinAndSelect('p.detalle', 'det')
      .leftJoinAndSelect('p.tracking', 'trk')
      .where('a.canceladoAt IS NULL')
      .orderBy('a.createdAt', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .getMany();

    const productosPedido = await this.productoRepo.find({
      relations: ['valor', 'detalle', 'tracking'],
    });

    const adelantosByVenta = new Map<number, VentaAdelanto>();
    for (const adelanto of adelantos) {
      if (adelanto.ventaId && !adelantosByVenta.has(adelanto.ventaId)) {
        adelantosByVenta.set(adelanto.ventaId, adelanto);
      }
    }

    const rows: any[] = [];
    const soldProductIds = new Set<number>();
    const pendingProductIds = new Set<number>();

    for (const venta of ventas) {
      const producto = venta.producto;
      const seller = normalizeSellerLabel(
        (venta as any).vendedor || (producto as any)?.vendedor,
      );
      const cliente = getPedidoClient(seller);
      if (!cliente) continue;

      soldProductIds.add(venta.productoId);
      const precioVenta = toMoneyNumber(venta.precioVenta);
      const gananciaRegistrada = toMoneyNumber(venta.ganancia);
      const costo = precioVenta || gananciaRegistrada ? precioVenta - gananciaRegistrada : getProductCost(producto);
      const stats = buildMoneyStats(precioVenta, costo);
      const adelanto = adelantosByVenta.get(venta.id);
      const montoAdelanto = adelanto ? toMoneyNumber(adelanto.montoAdelanto) : precioVenta;
      const status = getPedidoStatus(producto, 'pagado');

      rows.push({
        id: `venta-${venta.id}`,
        ventaId: venta.id,
        adelantoId: adelanto?.id ?? null,
        productoId: venta.productoId,
        cliente,
        vendedor: seller,
        estadoPago: status.estadoPago,
        estadoPedido: status.estadoPedido,
        trackingEstado: status.trackingEstado,
        producto: buildProductoNombre(producto),
        fecha: venta.fechaVenta,
        montoVenta: +precioVenta.toFixed(2),
        montoAdelanto: +montoAdelanto.toFixed(2),
        saldo: 0,
        costo: +costo.toFixed(2),
        ganancia: stats.ganancia,
        utilidadPct: stats.utilidadPct,
        markupPct: stats.markupPct,
      });
    }

    for (const adelanto of adelantos) {
      if (adelanto.canceladoAt || adelanto.completadoAt || soldProductIds.has(adelanto.productoId)) continue;
      const producto = adelanto.producto;
      const seller = normalizeSellerLabel((producto as any)?.vendedor);
      const cliente = getPedidoClient(seller);
      if (!cliente) continue;

      pendingProductIds.add(adelanto.productoId);
      const montoVenta = toMoneyNumber(adelanto.montoVenta);
      const montoAdelanto = toMoneyNumber(adelanto.montoAdelanto);
      const costo = getProductCost(producto);
      const stats = buildMoneyStats(montoVenta, costo);
      const status = getPedidoStatus(producto, 'adelanto');

      rows.push({
        id: `adelanto-${adelanto.id}`,
        ventaId: null,
        adelantoId: adelanto.id,
        productoId: adelanto.productoId,
        cliente,
        vendedor: seller,
        estadoPago: status.estadoPago,
        estadoPedido: status.estadoPedido,
        trackingEstado: status.trackingEstado,
        producto: buildProductoNombre(producto),
        fecha: adelanto.fechaAdelanto,
        montoVenta: +montoVenta.toFixed(2),
        montoAdelanto: +montoAdelanto.toFixed(2),
        saldo: +Math.max(0, montoVenta - montoAdelanto).toFixed(2),
        costo: +costo.toFixed(2),
        ganancia: stats.ganancia,
        utilidadPct: stats.utilidadPct,
        markupPct: stats.markupPct,
      });
    }

    for (const producto of productosPedido) {
      if (
        soldProductIds.has(producto.id) ||
        pendingProductIds.has(producto.id)
      ) {
        continue;
      }
      const seller = normalizeSellerLabel((producto as any)?.vendedor);
      const cliente = getPedidoClient(seller);
      if (!cliente) continue;

      const costo = getProductCost(producto);
      const status = getPedidoStatus(producto, 'sin_pago');
      const latestTracking = status.latestTracking;
      const fecha =
        (latestTracking as any)?.createdAt ||
        (producto as any)?.valor?.fechaCompra ||
        null;

      rows.push({
        id: `camino-${producto.id}`,
        ventaId: null,
        adelantoId: null,
        productoId: producto.id,
        cliente,
        vendedor: seller,
        estadoPago: status.estadoPago,
        estadoPedido: status.estadoPedido,
        trackingEstado: status.trackingEstado,
        producto: buildProductoNombre(producto),
        fecha,
        montoVenta: 0,
        montoAdelanto: 0,
        saldo: 0,
        costo: +costo.toFixed(2),
        ganancia: 0,
        utilidadPct: 0,
        markupPct: 0,
      });
    }

    const clientsMap = new Map<string, any>();
    const totals = {
      productos: 0,
      pagados: 0,
      pendientes: 0,
      ventaTotal: 0,
      adelantos: 0,
      saldo: 0,
      costo: 0,
      ganancia: 0,
      utilidadPct: 0,
      markupPct: 0,
    };

    for (const row of rows) {
      const current =
        clientsMap.get(row.cliente) ||
        {
          cliente: row.cliente,
          productos: 0,
          pagados: 0,
          pendientes: 0,
          ventaTotal: 0,
          adelantos: 0,
          saldo: 0,
          costo: 0,
          ganancia: 0,
          utilidadPct: 0,
          markupPct: 0,
        };

      current.productos += 1;
      current.pagados += row.estadoPago === 'pagado' ? 1 : 0;
      current.pendientes += row.estadoPago === 'pagado' ? 0 : 1;
      current.ventaTotal += toMoneyNumber(row.montoVenta);
      current.adelantos += toMoneyNumber(row.montoAdelanto);
      current.saldo += toMoneyNumber(row.saldo);
      current.costo += toMoneyNumber(row.costo);
      current.ganancia += toMoneyNumber(row.ganancia);
      clientsMap.set(row.cliente, current);

      totals.productos += 1;
      totals.pagados += row.estadoPago === 'pagado' ? 1 : 0;
      totals.pendientes += row.estadoPago === 'pagado' ? 0 : 1;
      totals.ventaTotal += toMoneyNumber(row.montoVenta);
      totals.adelantos += toMoneyNumber(row.montoAdelanto);
      totals.saldo += toMoneyNumber(row.saldo);
      totals.costo += toMoneyNumber(row.costo);
      totals.ganancia += toMoneyNumber(row.ganancia);
    }

    const finalize = (obj: any) => {
      obj.ventaTotal = +obj.ventaTotal.toFixed(2);
      obj.adelantos = +obj.adelantos.toFixed(2);
      obj.saldo = +obj.saldo.toFixed(2);
      obj.costo = +obj.costo.toFixed(2);
      obj.ganancia = +obj.ganancia.toFixed(2);
      obj.utilidadPct = obj.ventaTotal ? +((obj.ganancia / obj.ventaTotal) * 100).toFixed(2) : 0;
      obj.markupPct = obj.costo ? +((obj.ganancia / obj.costo) * 100).toFixed(2) : 0;
      return obj;
    };

    return {
      totals: finalize(totals),
      clients: Array.from(clientsMap.values())
        .map(finalize)
        .sort((a, b) => b.ventaTotal - a.ventaTotal),
      rows: rows.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || ''))),
    };
  }

  async createAdelanto(dto: CreateVentaAdelantoDto): Promise<VentaAdelanto> {
    if (!this.transactionManager) return this.inTransaction((service) => service.createAdelanto(dto));
    await this.transactionManager.query('SELECT id FROM producto WHERE id = $1 FOR UPDATE', [dto.productoId]);
    const producto = await this.productoRepo.findOne({
      where: { id: dto.productoId },
    });
    if (!producto)
      throw new NotFoundException(`Producto ${dto.productoId} no encontrado`);
    if (producto.archivadoAt || producto.cierreMotivo === 'no_comercializable') throw new BadRequestException('El producto está archivado o no está disponible para vender.');

    const existingVenta = await this.ventaRepo.findOne({
      where: { productoId: producto.id, estadoComercial: Not('cancelada') },
      order: { id: 'DESC' },
    });
    if (existingVenta) {
      throw new BadRequestException('El producto ya tiene una venta registrada.');
    }

    const existingAdelanto = await this.adelantoRepo.findOne({
      where: reservaActivaWhere(producto.id),
      order: { id: 'DESC' },
    });
    if (existingAdelanto) {
      throw new BadRequestException('El producto ya tiene un adelanto activo.');
    }

    const montoAdelanto = +Number(dto.montoAdelanto).toFixed(2);
    const montoVenta = +Number(dto.montoVenta).toFixed(2);
    if (montoAdelanto > montoVenta) {
      throw new BadRequestException(
        'El adelanto no puede superar el monto de la venta.',
      );
    }

    const adelanto = this.adelantoRepo.create({
      productoId: producto.id,
      montoAdelanto,
      fechaAdelanto: dto.fechaAdelanto,
      montoVenta,
      cuotas: [{ fecha: dto.fechaAdelanto, monto: montoAdelanto, banco: dto.incomeBank || 'bcp', tipoPago: dto.incomePaymentType || 'direct' }],
    });
    const saved = await this.adelantoRepo.save(adelanto);
    await this.syncAdelantoIncome(saved, producto);
    return saved;
  }

  async cancelAdelanto(
    id: number,
    opts: { fechaDevolucion?: string; montoDevuelto?: number; motivo?: string; cuentaId?: number } = {},
  ): Promise<void> {
    await this.adelantoRepo.manager.transaction(async (manager) => {
      const adelantoRepo = manager.getRepository(VentaAdelanto);
      const adelanto = await adelantoRepo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!adelanto) throw new NotFoundException(`Adelanto ${id} no encontrado`);
      if (adelanto.completadoAt || adelanto.ventaId) {
        throw new BadRequestException('No se puede cancelar un adelanto de una venta completada.');
      }
      if (adelanto.canceladoAt) return;
      const fecha = opts.fechaDevolucion || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new BadRequestException('Fecha de devolución inválida.');
      const pagadoCents = toCents(adelanto.montoAdelanto);
      const devueltoCents = opts.montoDevuelto == null ? pagadoCents : toCents(opts.montoDevuelto);
      if (devueltoCents < 0 || devueltoCents > pagadoCents) {
        throw new BadRequestException('El monto devuelto no puede superar lo adelantado.');
      }

      // El ingreso del adelanto se retira de Gastos como antes; el historial completo
      // (cobros y devolución) queda en la reserva y en el libro de pagos.
      const gastoRepo = manager.getRepository(Gasto);
      const ingresos = await gastoRepo.find({
        where: { concepto: 'ingreso', notas: Like(`__SALE_ADVANCE__:${id}:%`) },
      });
      if (this.ledger) await this.ledger.devolverPagosAdelanto(manager, id, fecha, devueltoCents, opts.cuentaId ?? null);
      if (ingresos.length && devueltoCents === pagadoCents) await gastoRepo.remove(ingresos);
      adelanto.canceladoAt = new Date();
      adelanto.fechaDevolucion = fecha;
      adelanto.montoDevuelto = devueltoCents / 100;
      adelanto.motivoCancelacion = opts.motivo || null;
      await adelantoRepo.save(adelanto);
    });
    await this.cache.del?.('productos:stats').catch?.(() => {});
    await this.cache.del?.('productos:resumen').catch?.(() => {});
  }

  async addAdelantoCuota(
    id: number,
    dto: AddVentaAdelantoCuotaDto,
  ): Promise<VentaAdelanto> {
    if (!this.transactionManager) return this.inTransaction((service) => service.addAdelantoCuota(id, dto));
    const adelanto = await this.adelantoRepo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!adelanto) throw new NotFoundException(`Adelanto ${id} no encontrado`);
    if (adelanto.canceladoAt) throw new BadRequestException('La reserva está cancelada.');
    if (adelanto.completadoAt) {
      if (dto.cerrarVenta) throw new BadRequestException('La venta ya está cerrada.');
      // En una venta cerrada, el nuevo pago se descuenta del cobro registrado al cerrar.
      const nuevaCuota: VentaAdelantoCuota = {
        fecha: dto.fechaCuota, monto: +Number(dto.montoCuota).toFixed(2),
        banco: dto.incomeBank || 'bcp', tipoPago: dto.incomePaymentType || 'direct',
      };
      const actuales = Array.isArray(adelanto.cuotas) && adelanto.cuotas.length ? adelanto.cuotas.length : 1;
      return this.changeAdelantoCuotas(id, actuales, (cuotas) => [...cuotas, nuevaCuota], false, true);
    }

    const montoCuota = +Number(dto.montoCuota).toFixed(2);
    const montoActual = +Number(adelanto.montoAdelanto || 0).toFixed(2);
    const montoVenta = +Number(adelanto.montoVenta || 0).toFixed(2);
    const nuevoTotal = +(montoActual + montoCuota).toFixed(2);
    if (!Number.isFinite(montoCuota) || montoCuota <= 0) throw new BadRequestException('Ingresa un monto mayor a cero.');
    if (dto.cerrarVenta && nuevoTotal < montoVenta) {
      throw new BadRequestException(`Falta S/ ${(montoVenta - nuevoTotal).toFixed(2)} para cerrar la venta.`);
    }

    if (nuevoTotal > montoVenta) {
      const restante = Math.max(+(montoVenta - montoActual).toFixed(2), 0);
      throw new BadRequestException(
        `El nuevo adelanto supera el saldo pendiente de S/ ${restante.toFixed(2)}.`,
      );
    }

    const cuotas = Array.isArray(adelanto.cuotas)
      ? [...adelanto.cuotas]
      : [];
    if (cuotas.length === 0 && montoActual > 0) {
      cuotas.push({
        fecha: adelanto.fechaAdelanto,
        monto: montoActual,
      });
    }
    cuotas.push({ fecha: dto.fechaCuota, monto: montoCuota, banco: dto.incomeBank || 'bcp', tipoPago: dto.incomePaymentType || 'direct' });

    adelanto.cuotas = cuotas;
    adelanto.montoAdelanto = nuevoTotal;
    const saved = await this.adelantoRepo.save(adelanto);
    const producto = await this.productoRepo.findOne({ where: { id: adelanto.productoId } });
    await this.syncAdelantoIncome(saved, producto);
    if (dto.cerrarVenta) {
      await this.completeAdelanto(id, dto.cerrarVenta);
      return this.findAdelanto(id);
    }
    return saved;
  }

  private cierreReferences(adelanto: VentaAdelanto) {
    if (!adelanto.ventaId) return [];
    const bases = [`__SALE_INCOME__:${adelanto.productoId}:${adelanto.ventaId}`, `__SALE_INCOME__:${adelanto.productoId}`];
    return [String(adelanto.productoId), ...bases.flatMap((base) => [base, ...['direct', 'card', 'debt', 'cash'].map((type) => `${base}:${type}`)])];
  }

  private isResumenCierre(row: Gasto, adelanto: VentaAdelanto, venta: Venta | null) {
    if (!venta || isAdvanceIncome(row)) return false;
    if (row.saleId === venta.id) return true;
    if (row.saleId != null || row.metodoPago !== 'debito') return false;
    const reference = String(row.notas || '');
    if (!this.cierreReferences(adelanto).includes(reference)) return false;
    const canonical = `__SALE_INCOME__:${adelanto.productoId}:${venta.id}`;
    return reference === canonical || reference.startsWith(`${canonical}:`)
      || String(row.fecha).slice(0, 10) === String(venta.fechaVenta).slice(0, 10);
  }

  async resumenAdelanto(id: number) {
    const adelanto = await this.findAdelanto(id);
    const [producto, venta, rows] = await Promise.all([
      this.productoRepo.findOne({ where: { id: adelanto.productoId } }),
      adelanto.ventaId ? this.findOne(adelanto.ventaId) : Promise.resolve(null),
      this.gastoRepo ? this.gastoRepo.find({ where: [
        { concepto: 'ingreso', notas: Like(`__SALE_ADVANCE__:${id}:%`) },
        ...(adelanto.ventaId ? [
          { concepto: 'ingreso', saleId: adelanto.ventaId },
          { concepto: 'ingreso', metodoPago: 'debito' as const, saleId: IsNull(), notas: In(this.cierreReferences(adelanto)) },
        ] : []),
      ] }) : Promise.resolve([]),
    ]);
    return this.buildAdelantoResumen(adelanto, producto, venta, rows);
  }

  async resumenAdelantos(ids: number[]) {
    if (!ids.length) return [];
    const adelantos = await this.adelantoRepo.find({ where: { id: In(ids) } });
    if (!adelantos.length) return [];
    const saleIds = adelantos.map((item) => item.ventaId).filter((id): id is number => Boolean(id));
    const [productos, ventas, rows] = await Promise.all([
      this.productoRepo.find({ where: { id: In(adelantos.map((item) => item.productoId)) } }),
      saleIds.length ? this.ventaRepo.find({ where: { id: In(saleIds) } }) : Promise.resolve([]),
      this.gastoRepo ? this.gastoRepo.find({ where: [
        ...adelantos.map((item) => ({ concepto: 'ingreso', notas: Like(`__SALE_ADVANCE__:${item.id}:%`) })),
        ...(saleIds.length ? [
          { concepto: 'ingreso', saleId: In(saleIds) },
          { concepto: 'ingreso', metodoPago: 'debito' as const, saleId: IsNull(), notas: In(adelantos.flatMap((item) => this.cierreReferences(item))) },
        ] : []),
      ] }) : Promise.resolve([]),
    ]);
    const productMap = new Map(productos.map((item) => [item.id, item]));
    const saleMap = new Map(ventas.map((item) => [item.id, item]));
    return adelantos.map((item) => this.buildAdelantoResumen(item,
      productMap.get(item.productoId) || null, saleMap.get(item.ventaId!) || null,
      rows.filter((row) => String(row.notas || '').startsWith(`__SALE_ADVANCE__:${item.id}:`) || this.isResumenCierre(row, item, saleMap.get(item.ventaId!) || null)),
    ));
  }

  private buildAdelantoResumen(adelanto: VentaAdelanto, producto: Producto | null, venta: Venta | null, rows: Gasto[]) {
    const id = adelanto.id;
    const cuotas = adelanto.cuotas?.length ? adelanto.cuotas : [
      { fecha: adelanto.fechaAdelanto, monto: Number(adelanto.montoAdelanto) } as VentaAdelantoCuota,
    ];
    const pagos: Array<{ index: number; fecha: string; monto: number; banco: string; tipoPago: string; origen: string; editable: boolean; gastoIds: number[] }> = cuotas.map((cuota, index) => ({
      index, fecha: cuota.fecha, monto: Number(cuota.monto), banco: cuota.banco || 'bcp',
      tipoPago: cuota.tipoPago || 'direct', origen: cuota.pagoId ? 'finanzas' : 'reserva',
      editable: !cuota.pagoId && !adelanto.canceladoAt,
      gastoIds: rows.filter((row) => row.notas === `__SALE_ADVANCE__:${id}:${index}`).map((row) => row.id),
    }));
    const cierre = rows.filter((row) => this.isResumenCierre(row, adelanto, venta));
    if (cierre.length) pagos.push({
      index: -1, fecha: String(venta!.fechaVenta),
      monto: cierre.reduce((sum, row) => sum + toCents(row.monto), 0) / 100,
      banco: cierre[0].tarjeta || 'bcp', tipoPago: cierre[0].salePaymentType || 'direct',
      origen: 'cierre', editable: !adelanto.canceladoAt && cierre.every((row) => row.saleId === venta!.id) && new Set(cierre.map((row) => row.salePaymentType)).size === 1,
      gastoIds: cierre.map((row) => row.id),
    });
    const precio = Number(venta?.precioVenta ?? adelanto.montoVenta);
    const received = (row: Gasto) => row.salePaymentType === 'card' || row.salePaymentType === 'debt'
      ? toCents(row.saleReceivedAmount) : toCents(row.saleReceivedAmount ?? row.monto);
    const cobrado = pagos.reduce((sum, pago) => {
      const linked = rows.filter((row) => pago.gastoIds.includes(row.id));
      if (linked.length) return sum + linked.reduce((total, row) => total + received(row), 0);
      return sum + (pago.tipoPago === 'card' || pago.tipoPago === 'debt' ? 0 : toCents(pago.monto));
    }, 0) / 100;
    const falta = Math.max(0, toCents(precio) - toCents(cobrado)) / 100;
    return { ...adelanto, producto: { id: producto?.id, nombre: buildProductoNombre(producto),
      codigo: `MS-${producto?.codigoInventario || adelanto.productoId}`, vendedor: producto?.vendedor },
      precio, cobrado, falta, estado: adelanto.canceladoAt ? 'cancelado' : venta ? 'vendido' : falta === 0 ? 'pagado' : 'reservado',
      fechaVenta: venta?.fechaVenta || null, pagos };
  }

  async findAdelanto(id: number): Promise<VentaAdelanto> {
    const adelanto = await this.adelantoRepo.findOne({ where: { id }, ...(this.transactionManager ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (!adelanto) throw new NotFoundException(`Adelanto ${id} no encontrado`);
    return adelanto;
  }

  async updateAdelantoCuota(id: number, index: number, dto: AddVentaAdelantoCuotaDto): Promise<VentaAdelanto> {
    return this.changeAdelantoCuotas(id, index, (cuotas) => cuotas.map((cuota, i) => i !== index ? cuota : {
      ...cuota,
      fecha: dto.fechaCuota,
      monto: +Number(dto.montoCuota).toFixed(2),
      ...(dto.incomeBank ? { banco: dto.incomeBank } : {}),
      ...(dto.incomePaymentType ? { tipoPago: dto.incomePaymentType } : {}),
    }));
  }

  async deleteAdelantoCuota(id: number, index: number): Promise<VentaAdelanto> {
    return this.changeAdelantoCuotas(id, index, (cuotas) => cuotas.filter((_, i) => i !== index), true);
  }

  // Edita las cuotas de una reserva (activa o ya vendida) y vuelve a derivar sus ingresos en Gastos.
  private async changeAdelantoCuotas(
    id: number,
    index: number,
    change: (cuotas: VentaAdelantoCuota[]) => VentaAdelantoCuota[],
    removing = false,
    appending = false,
  ): Promise<VentaAdelanto> {
    if (!this.transactionManager) return this.inTransaction((service) => service.changeAdelantoCuotas(id, index, change, removing, appending));
    const adelanto = await this.findAdelanto(id);
    if (adelanto.canceladoAt) throw new BadRequestException('No se puede editar un adelanto cancelado.');
    const cuotas: VentaAdelantoCuota[] = Array.isArray(adelanto.cuotas) && adelanto.cuotas.length
      ? adelanto.cuotas.map((cuota) => ({ ...cuota }))
      : [{ fecha: String(adelanto.fechaAdelanto).slice(0, 10), monto: Number(adelanto.montoAdelanto) }];
    if (!Number.isInteger(index) || index < 0 || index >= cuotas.length + (appending ? 1 : 0)) {
      throw new NotFoundException(`Adelanto ${index + 1} no encontrado`);
    }
    if (cuotas[index]?.pagoId) {
      throw new BadRequestException('Este adelanto se registró desde el libro de pagos; edítalo o anúlalo en Finanzas.');
    }
    if (removing && cuotas.length === 1) {
      throw new BadRequestException('La reserva debe conservar al menos un adelanto; usa "Cancelar venta" para anularla.');
    }
    const next = change(cuotas);
    const totalCents = next.reduce((sum, cuota) => sum + toCents(cuota.monto), 0);
    const venta = adelanto.ventaId ? await this.findOne(adelanto.ventaId) : null;
    const limitCents = toCents(venta ? venta.precioVenta : adelanto.montoVenta);
    if (totalCents > limitCents) {
      throw new BadRequestException(`Los adelantos no pueden superar el total de venta de S/ ${(limitCents / 100).toFixed(2)}.`);
    }

    // Saldo cobrado al completar: con una sola forma de cobro se ajusta al nuevo saldo.
    let saleParts: Array<{ type: 'direct' | 'card' | 'debt' | 'cash'; amount: number }> | undefined;
    let saleBank: string | undefined;
    if (venta && this.gastoRepo) {
      const incomes = (await this.gastoRepo.find({ where: { saleId: venta.id, concepto: 'ingreso' } }))
        .filter((row) => !isAdvanceIncome(row));
      const types = [...new Set(incomes.map((row) => row.salePaymentType).filter(Boolean))] as Array<'direct' | 'card' | 'debt' | 'cash'>;
      if (types.length > 1 && totalCents !== toCents(adelanto.montoAdelanto)) {
        throw new BadRequestException('La venta tiene cobros combinados: ajusta primero sus cobros con "Editar venta e ingresos".');
      }
      saleBank = incomes.find((row) => row.tarjeta && row.tarjeta !== 'efectivo')?.tarjeta || undefined;
      if (types.length === 1 && limitCents > totalCents) {
        saleParts = [{ type: types[0], amount: (limitCents - totalCents) / 100 }];
        if (types[0] !== 'cash') saleBank = saleBank || 'bcp';
      }
      // Se valida antes de escribir para no dejar la reserva cambiada con ingresos desfasados.
      const receivedOnCredit = incomes.filter((row) => row.salePaymentType === 'card' || row.salePaymentType === 'debt')
        .reduce((sum, row) => sum + toCents(row.saleReceivedAmount), 0);
      if (types.length === 1 && receivedOnCredit > limitCents - totalCents) {
        throw new BadRequestException('El nuevo saldo de la venta es menor que los pagos ya recibidos.');
      }
    }
    if (!removing && this.gastoRepo && next[index].tipoPago === 'card') {
      const rows = await this.gastoRepo.find({ where: { concepto: 'ingreso', notas: `__SALE_ADVANCE__:${adelanto.id}:${index}` } });
      if (rows.reduce((sum, row) => sum + toCents(row.saleReceivedAmount), 0) > toCents(next[index].monto)) {
        throw new BadRequestException('El adelanto es menor que los pagos ya recibidos.');
      }
    }

    const producto = await this.productoRepo.findOne({ where: { id: adelanto.productoId } });
    await this.adoptManualAdvanceIncome(adelanto.id, cuotas, producto?.vendedor);
    if (removing) await this.shiftAdvanceIncomeRows(adelanto.id, index);

    adelanto.cuotas = next;
    adelanto.montoAdelanto = totalCents / 100;
    adelanto.fechaAdelanto = next[0].fecha;
    const saved = await this.adelantoRepo.save(adelanto);
    await this.syncAdelantoIncome(saved, producto);
    if (venta) await this.syncSaleIncome(venta, saleBank, undefined, undefined, saleParts);
    await this.cache.del?.('productos:stats').catch?.(() => {});
    return saved;
  }

  // Las cuotas antiguas sin banco reutilizaban un ingreso manual idéntico; al editarlas se vincula
  // ese ingreso a la cuota para que no quede duplicado con el que se genera automáticamente.
  private async adoptManualAdvanceIncome(adelantoId: number, cuotas: VentaAdelantoCuota[], vendedor?: string | null) {
    if (!this.gastoRepo || !this.userRepo) return;
    const owners = advanceOwners(vendedor);
    for (const [index, cuota] of cuotas.entries()) {
      const cents = toCents(cuota.monto);
      if (cuota.banco || cuota.tipoPago || cents <= 0) continue;
      const reference = `__SALE_ADVANCE__:${adelantoId}:${index}`;
      let allocated = 0;
      for (const [ownerIndex, owner] of owners.entries()) {
        const ownerCents = ownerIndex === owners.length - 1 ? cents - allocated : Math.round(cents / owners.length);
        allocated += ownerCents;
        const user = await this.resolveIncomeUser(owner);
        if (!user?.id || ownerCents <= 0) continue;
        const linked = await this.gastoRepo.find({ where: { concepto: 'ingreso', metodoPago: 'debito', notas: reference, userId: user.id } });
        if (linked.length) continue;
        const matches = (await this.gastoRepo.find({ where: {
          userId: user.id, concepto: 'ingreso', metodoPago: 'debito', moneda: 'PEN',
          fecha: cuota.fecha, monto: (ownerCents / 100).toFixed(2),
        } })).filter((row) => !row.saleId && !String(row.notas || '').startsWith('__SALE_'));
        if (matches.length === 1) await this.gastoRepo.save(Object.assign(matches[0], { notas: reference }));
      }
    }
  }

  // Al quitar una cuota, los ingresos de las siguientes conservan su referencia por posición.
  private async shiftAdvanceIncomeRows(adelantoId: number, removedIndex: number) {
    if (!this.gastoRepo) return;
    const prefix = `__SALE_ADVANCE__:${adelantoId}:`;
    const rows = await this.gastoRepo.find({ where: { concepto: 'ingreso', notas: Like(`${prefix}%`) } });
    const indexOf = (row: Gasto) => Number(String(row.notas).slice(prefix.length));
    const removed = rows.filter((row) => indexOf(row) === removedIndex);
    if (removed.length) await this.gastoRepo.remove(removed);
    for (const row of rows.filter((item) => indexOf(item) > removedIndex).sort((a, b) => indexOf(a) - indexOf(b))) {
      row.notas = `${prefix}${indexOf(row) - 1}`;
      await this.gastoRepo.save(row);
    }
  }

  async completeAdelanto(id: number, dto: CompleteVentaAdelantoDto): Promise<Venta> {
    if (!this.transactionManager) return this.inTransaction((service) => service.completeAdelanto(id, dto));
    const adelanto = await this.adelantoRepo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!adelanto) throw new NotFoundException(`Adelanto ${id} no encontrado`);
    if (adelanto.canceladoAt) throw new BadRequestException('La reserva está cancelada.');
    if (adelanto.completadoAt) {
      if (!adelanto.ventaId) throw new BadRequestException('El adelanto ya fue completado.');
      const savedSale = await this.findOne(adelanto.ventaId);
      const savedProduct = await this.productoRepo.findOne({ where: { id: adelanto.productoId } });
      await this.syncAdelantoIncome(adelanto, savedProduct);
      await this.syncSaleIncome(savedSale, dto.incomeBank, dto.incomePaymentType || 'direct', undefined, dto.incomeParts);
      return savedSale;
    }

    const producto = await this.productoRepo.findOne({
      where: { id: adelanto.productoId },
      relations: ['valor'],
    });
    if (!producto?.valor)
      throw new BadRequestException(
        'El producto no tiene seccion de valor asociada',
      );

    const v = producto.valor;
    const valorProductoUSD = Number(v.valorProducto);
    if (!valorProductoUSD) {
      throw new BadRequestException(
        'El producto no tiene valor USD para calcular el tipo de cambio.',
      );
    }
    const tipoCambio = Number(dto.tipoCambio);
    if (!tipoCambio) {
      throw new BadRequestException('Tipo de cambio invalido.');
    }
    const costoEnvioSoles = Number(
      (v as any).costoEnvioProrrateado ?? v.costoEnvio ?? 0,
    );
    const valorSolesRecalc = costoEnSoles(v, tipoCambio);
    const costoTotalRecalc = +(valorSolesRecalc + costoEnvioSoles).toFixed(2);

    v.valorSoles = valorSolesRecalc;
    v.costoTotal = costoTotalRecalc;
    await this.valorRepo.save(v);

    const precioVenta = Number(adelanto.montoVenta);
    const ganancia = +(precioVenta - costoTotalRecalc).toFixed(2);
    const porcentajeGanancia = calculateProfitPercentage(
      ganancia,
      costoTotalRecalc,
    );

    const venta = this.ventaRepo.create({
      productoId: producto.id,
      tipoCambio,
      fechaVenta: dto.fechaVenta,
      fechaReserva: adelanto.fechaAdelanto,
      precioVenta,
      ganancia,
      porcentajeGanancia,
      vendedor: sellerFromProducto(producto, null),
    });
    const saved = await this.ventaRepo.save(venta);

    adelanto.ventaId = saved.id;
    adelanto.completadoAt = new Date();
    await this.adelantoRepo.save(adelanto);
    await this.syncAdelantoIncome(adelanto, producto);
    await this.syncSaleIncome(saved, dto.incomeBank, dto.incomePaymentType || 'direct', undefined, dto.incomeParts);
    await this.cache.del?.('productos:stats').catch?.(() => {});
    return saved;
  }

  async findOne(id: number): Promise<Venta> {
    const v = await this.ventaRepo.findOne({ where: { id } });
    if (!v) throw new NotFoundException(`Venta ${id} no encontrada`);
    return v;
  }

  async getAccessorySalesSummary(productoId: number) {
    const requested = await this.productoRepo.findOne({
      where: { id: productoId },
      relations: ['valor', 'tracking'],
    });
    if (!requested || !isAccessoryStock(requested.tipo)) {
      throw new NotFoundException(`Accesorio ${productoId} no encontrado`);
    }
    const visibleCode = Number(requested.codigoInventario || requested.id);
    const lots = await this.productoRepo.find({
      where: [{ id: requested.id }, { codigoInventario: visibleCode }],
      relations: ['valor', 'tracking'],
    });
    const validLots = lots.filter((lot) => isAccessoryStock(lot.tipo)
      && normalizeSeller(lot.vendedor) === normalizeSeller(requested.vendedor));
    const lotIds = validLots.map((lot) => lot.id);
    const sales = lotIds.length
      ? await this.ventaRepo.find({
          where: { productoId: In(lotIds), estadoComercial: Not('cancelada') },
          order: { fechaVenta: 'ASC', id: 'ASC' },
        })
      : [];

    const lotsById = new Map(validLots.map((lot) => [Number(lot.id), lot]));
    let unidadesVendidas = 0;
    let ventaBruta = 0;
    let costoVendido = 0;
    let weightedTc = 0;
    const detalleVentas = sales.map((sale) => {
      const cantidad = Math.max(1, Number(sale.cantidad || 1) - Number(sale.cantidadDevuelta || 0));
      const distribution = Array.isArray(sale.distribucionStock) && sale.distribucionStock.length
        ? sale.distribucionStock
        : [{ productoId: sale.productoId, cantidad: Number(sale.cantidad || 1) }];
      const bruto = Number(sale.precioVenta || 0) - Number(sale.precioDevuelto || 0);
      const costo = distribution.reduce((sum, item) => {
        const lot = lotsById.get(Number(item.productoId));
        if (item.costoUnitario != null) return sum + Number(item.costoUnitario) * Math.max(0, Number(item.cantidad || 0));
        if (!lot?.valor) return sum;
        const totalLotCost = Number(lot.valor.costoTotalProrrateado ?? lot.valor.costoTotal ?? lot.valor.valorSoles ?? 0);
        const unitCost = totalLotCost / Math.max(1, Number(lot.stockInicial || 1));
        return sum + unitCost * Math.max(0, Number(item.cantidad || 0));
      }, 0) - Number(sale.costoDevuelto || 0);
      const gananciaNeta = bruto - costo;
      unidadesVendidas += cantidad;
      ventaBruta += bruto;
      costoVendido += costo;
      weightedTc += Number(sale.tipoCambio || 0) * cantidad;
      return {
        id: sale.id,
        fechaVenta: sale.fechaVenta,
        cantidad,
        precioUnitario: +(bruto / cantidad).toFixed(2),
        ventaBruta: +bruto.toFixed(2),
        costo: sale.costoPendiente ? null : +costo.toFixed(2),
        gananciaNeta: sale.costoPendiente ? null : +gananciaNeta.toFixed(2),
        tipoCambio: Number(sale.tipoCambio || 0),
        distribucionStock: distribution,
      };
    });

    return {
      codigoInventario: visibleCode,
      unidadesCompradas: validLots.reduce((sum, lot) => sum + Number(lot.stockInicial || 0), 0),
      unidadesDisponibles: validLots.reduce((sum, lot) => sum + Number(lot.stockActual || 0), 0),
      unidadesVendidas,
      ventaBruta: +ventaBruta.toFixed(2),
      costosPendientes: sales.filter((sale) => sale.costoPendiente).length,
      costoVendido: sales.some((sale) => sale.costoPendiente) ? null : +costoVendido.toFixed(2),
      gananciaNeta: sales.some((sale) => sale.costoPendiente) ? null : +(ventaBruta - costoVendido).toFixed(2),
      tipoCambioPromedio: unidadesVendidas ? +(weightedTc / unidadesVendidas).toFixed(4) : null,
      ventas: detalleVentas.reverse(),
    };
  }

  async create(dto: CreateVentaDto): Promise<Venta> {
    this.validateSaleAmounts(dto);
    if (!this.transactionManager) return this.inTransaction((service) => service.create(dto));
    const hash = operationHash(dto);
    if (dto.operacionKey) {
      await this.transactionManager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`venta:${dto.operacionKey}`]);
      const previous = await this.ventaRepo.findOne({ where: { operacionKey: dto.operacionKey } });
      if (previous) {
        if (previous.operacionHash !== hash) throw new ConflictException('La clave de operación ya se utilizó con otros datos.');
        return previous;
      }
    }
    const [base] = await this.transactionManager.query('SELECT tipo FROM producto WHERE id = $1', [dto.productoId]);
    // Equipos: exclusión por producto. Accesorios: todos los lotes se bloquean
    // juntos en orden de ID; bloquear antes el lote elegido permitiría un ciclo.
    if (!isAccessoryStock(base?.tipo)) await this.transactionManager.query('SELECT id FROM producto WHERE id = $1 FOR UPDATE', [dto.productoId]);
    this.validateFinancialFields(dto, Number(dto.precioVenta));
    const saved = await this.createSale(dto);
    if (dto.operacionKey) {
      if (saved.operacionKey && saved.operacionKey !== dto.operacionKey) throw new ConflictException('El equipo ya se vendió en otra operación.');
      await this.ventaRepo.update(saved.id, { operacionKey: dto.operacionKey, operacionHash: hash });
      Object.assign(saved, { operacionKey: dto.operacionKey, operacionHash: hash });
    }
    return this.applyFinancialFields(saved, dto);
  }

  private validateFinancialFields(
    dto: { precioLista?: number; descuento?: number; grupoOperacion?: string },
    precioVenta: number,
  ) {
    if (dto.precioLista != null && dto.descuento != null
      && toCents(dto.precioLista) - toCents(dto.descuento) !== toCents(precioVenta)) {
      throw new BadRequestException('El precio pactado menos el descuento debe coincidir con el precio de venta.');
    }
    if (dto.grupoOperacion != null && String(dto.grupoOperacion).length > 64) {
      throw new BadRequestException('Identificador de operación demasiado largo.');
    }
  }

  private validateSaleAmounts(dto: Partial<CreateVentaDto>) {
    if (dto.precioVenta !== undefined && (!Number.isFinite(dto.precioVenta) || dto.precioVenta <= 0 || dto.precioVenta > 99999999.99
      || Math.abs(dto.precioVenta * 100 - Math.round(dto.precioVenta * 100)) > 0.000001)) {
      throw new BadRequestException('Precio inválido: debe ser positivo y tener como máximo dos decimales.');
    }
    for (const value of [dto.tipoCambio, dto.tipoCambioGonzalo, dto.tipoCambioRenato]) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > 1000)) throw new BadRequestException('Tipo de cambio inválido.');
    }
    if (dto.cantidad !== undefined && (!Number.isInteger(dto.cantidad) || dto.cantidad < 1)) throw new BadRequestException('Cantidad inválida.');
  }

  // Guarda precio pactado, descuento y agrupación sin alterar el cálculo de la ganancia.
  private async applyFinancialFields(
    venta: Venta,
    dto: { precioLista?: number; descuento?: number; grupoOperacion?: string },
  ): Promise<Venta> {
    if (!venta?.id || (dto.precioLista == null && dto.descuento == null && dto.grupoOperacion == null)) return venta;
    const precio = toCents(venta.precioVenta);
    const descuento = dto.descuento != null ? toCents(dto.descuento)
      : dto.precioLista != null ? Math.max(0, toCents(dto.precioLista) - precio) : toCents(venta.descuento);
    const changes: Partial<Venta> = {
      descuento: descuento / 100,
      precioLista: (dto.precioLista != null ? toCents(dto.precioLista) : precio + descuento) / 100,
      ...(dto.grupoOperacion != null ? { grupoOperacion: dto.grupoOperacion || null } : {}),
    };
    await this.ventaRepo.update(venta.id, changes);
    return Object.assign(venta, changes);
  }

  private async createSale(dto: CreateVentaDto): Promise<Venta> {
    if (dto.incomeParts !== undefined) {
      const parts = dto.incomeParts;
      const cents = parts.map((part) => Math.round(Number(part.amount) * 100));
      if (!parts.length || new Set(parts.map((part) => part.type)).size !== parts.length
        || parts.some((part, index) => !['direct', 'card', 'debt', 'cash'].includes(part.type)
          || !Number.isSafeInteger(cents[index]) || cents[index] <= 0
          || Math.abs(cents[index] / 100 - Number(part.amount)) > 0.000001)
        || cents.reduce((sum, value) => sum + value, 0) !== Math.round(Number(dto.precioVenta) * 100)) {
        throw new BadRequestException('Las partes del cobro deben sumar el precio total de la venta.');
      }
    }
    const existing = await this.findExistingByProducto(dto.productoId);
    if (existing && !isAccessoryStock(existing.producto?.tipo)) {
      await this.syncSaleIncome(existing, dto.incomeBank, dto.incomePaymentType, dto.incomeSku, dto.incomeParts, { cuentaId: dto.incomeAccountId, metodo: dto.incomeMethod });
      return existing;
    }

    // 1) Cargar producto con valor
    const producto = await this.productoRepo.findOne({
      where: { id: dto.productoId },
      relations: ['valor'],
    });
    if (!producto)
      throw new NotFoundException(`Producto ${dto.productoId} no encontrado`);
    if (producto.archivadoAt || producto.cierreMotivo === 'no_comercializable') throw new BadRequestException('El producto está archivado o no está disponible para vender.');
    if (!producto.valor)
      throw new BadRequestException(
        'El producto no tiene sección de valor asociada',
      );

    if (isAccessoryStock(producto.tipo)) {
      const cantidad = Number(dto.cantidad || 1);
      const modalidad = dto.modalidad === 'mayor' || cantidad > 1 ? 'mayor' : 'unidad';
      const saved = await this.productoRepo.manager.transaction(async (manager) => {
        const transactionProductRepo = manager.getRepository(Producto);
        // PostgreSQL no permite FOR UPDATE sobre los LEFT JOIN que TypeORM crea
        // para las relaciones eager. Primero bloqueamos solo las filas base y,
        // manteniendo la misma transaccion, cargamos luego costo y tracking.
        const lockedBase = await transactionProductRepo
          .createQueryBuilder('producto')
          .where('producto.id = :id', { id: producto.id })
          .getOne();
        if (!lockedBase) throw new NotFoundException(`Producto ${producto.id} no encontrado`);
        const tipoCambio = Number(dto.tipoCambio);
        if (!tipoCambio) throw new BadRequestException('Tipo de cambio invalido.');
        const visibleCode = Number(lockedBase.codigoInventario || lockedBase.id);
        const lockedIdRows = await transactionProductRepo
          .createQueryBuilder('producto')
          .select('producto.id', 'id')
          .where('(producto.id = :requestedId OR producto.codigoInventario = :visibleCode)', { requestedId: lockedBase.id, visibleCode })
          .orderBy('producto.id', 'ASC')
          .setLock('pessimistic_write')
          .getRawMany();
        const lockedIds = lockedIdRows.map((row) => Number(row.id)).filter(Boolean);
        const groupCandidates = lockedIds.length
          ? await transactionProductRepo.find({
              where: { id: In(lockedIds) },
              relations: ['valor', 'tracking'],
            })
          : [];
        const groupLots = groupCandidates.filter((candidate) => isAccessoryStock(candidate.tipo)
          && !candidate.archivadoAt && candidate.cierreMotivo !== 'no_comercializable'
          && normalizeSeller(candidate.vendedor) === normalizeSeller(lockedBase.vendedor));
        const locked = groupLots.find((lot) => lot.id === producto.id);
        if (!locked?.valor) throw new BadRequestException('El accesorio no tiene costo asociado.');
        const purchaseOwner = normalizeSeller(locked.vendedor);
        if (purchaseOwner && dto.vendedor && normalizeSeller(dto.vendedor) !== purchaseOwner) {
          throw new BadRequestException('La ganancia del accesorio corresponde al comprador. Corrige el comprador en Inventario antes de vender.');
        }
        groupLots.sort((a, b) => getAccessoryLotDate(a) - getAccessoryLotDate(b) || a.id - b.id);
        if (dto.loteInicialId != null) {
          const selectedIndex = groupLots.findIndex((lot) => lot.id === dto.loteInicialId);
          if (selectedIndex < 0) throw new BadRequestException('El lote seleccionado no pertenece a este accesorio.');
          if (Number(groupLots[selectedIndex].stockActual || 0) < 1) throw new BadRequestException('El lote seleccionado no tiene stock.');
          groupLots.unshift(groupLots.splice(selectedIndex, 1)[0]);
        }
        const availableStock = groupLots.reduce(
          (sum, lot) => sum + Math.max(0, Number(lot.stockActual || 0)),
          0,
        );
        if (availableStock < cantidad) {
          throw new BadRequestException(`Stock insuficiente. Quedan ${availableStock} unidades.`);
        }
        const precioVenta = Number(dto.precioVenta);
        let pending = cantidad;
        let costoVendido = 0;
        const distribucionStock: Array<{ productoId: number; cantidad: number; costoUnitario?: number }> = [];
        let costoPendiente = false;
        for (const lot of groupLots) {
          if (pending <= 0) break;
          const taken = Math.min(Math.max(0, Number(lot.stockActual || 0)), pending);
          if (!taken) continue;
          lot.stockActual = Number(lot.stockActual) - taken;
          pending -= taken;
          const costoUnitario = getAccessoryUnitCost(lot);
          const sinCosto = lot.valor.costoTotalProrrateado == null && lot.valor.costoTotal == null && lot.valor.valorSoles == null;
          costoPendiente ||= sinCosto;
          distribucionStock.push({ productoId: lot.id, cantidad: taken, ...(sinCosto ? {} : { costoUnitario }) });
          costoVendido += costoUnitario * taken;
          await manager.getRepository(Producto).save(lot);
        }
        const ganancia = +(precioVenta - costoVendido).toFixed(2);
        return manager.getRepository(Venta).save(manager.getRepository(Venta).create({
          productoId: locked.id,
          tipoCambio,
          fechaVenta: dto.fechaVenta,
          precioVenta,
          cantidad,
          modalidad,
          distribucionStock,
          costoPendiente,
          ganancia,
          porcentajeGanancia: calculateProfitPercentage(ganancia, costoVendido),
          vendedor: normalizeSellerLabel(dto.vendedor) ?? sellerFromProducto(locked, null),
        }));
      });
      await this.syncSaleIncome(saved, dto.incomeBank, dto.incomePaymentType, dto.incomeSku, dto.incomeParts, { cuentaId: dto.incomeAccountId, metodo: dto.incomeMethod });
      await this.cache.del?.('productos:stats').catch?.(() => {});
      await this.cache.del?.('productos:resumen').catch?.(() => {});
      return saved;
    }

    // Los equipos son unidades únicas; los reintentos devuelven la misma fila.
    const v = producto.valor;
    const resolvedSeller =
      normalizeSellerLabel((dto as any).vendedor) ?? sellerFromProducto(producto, null);

    // 2) Recalcular costos con el tipo de cambio ingresado
    const costoEnvioSoles = Number(
      (v as any).costoEnvioProrrateado ?? v.costoEnvio ?? 0,
    ); // S/

    const splitRequested =
      isSplitSeller(resolvedSeller) ||
      (dto as any).tipoCambioGonzalo != null ||
      (dto as any).tipoCambioRenato != null;

    if (splitRequested) {
      const tipoCambioGonzalo = Number(
        (dto as any).tipoCambioGonzalo ?? dto.tipoCambio,
      );
      const tipoCambioRenato = Number(
        (dto as any).tipoCambioRenato ?? dto.tipoCambio,
      );
      if (!tipoCambioGonzalo || !tipoCambioRenato) {
        throw new BadRequestException(
          'Tipo de cambio invalido para venta conjunta.',
        );
      }

      const { total, valorSoles } = calcSplitCosts(v, costoEnvioSoles, tipoCambioGonzalo, tipoCambioRenato);

      v.valorSoles = valorSoles;
      v.costoTotal = total;
      await this.valorRepo.save(v);

      const precioVenta = Number(dto.precioVenta);
      const ganancia = +(precioVenta - total).toFixed(2);
      const porcentajeGanancia = calculateProfitPercentage(ganancia, total);

      const avgTc = +(((tipoCambioGonzalo + tipoCambioRenato) / 2).toFixed(4));

      const venta = this.ventaRepo.create({
        productoId: producto.id,
        tipoCambio: avgTc,
        tipoCambioGonzalo,
        tipoCambioRenato,
        fechaVenta: dto.fechaVenta,
        precioVenta,
        ganancia,
        porcentajeGanancia,
        cantidad: 1,
        modalidad: 'unidad',
        vendedor:
          normalizeSellerLabel((dto as any).vendedor) ??
          sellerFromProducto(producto, 'ambos'),
      });
      const saved = await this.saveIdempotent(venta);
      await this.syncSaleIncome(saved, dto.incomeBank, dto.incomePaymentType, dto.incomeSku, dto.incomeParts, { cuentaId: dto.incomeAccountId, metodo: dto.incomeMethod });
      // invalidar KPIs de productos
      await this.cache.del?.('productos:stats').catch?.(() => {});
      return saved;
    }

    const tipoCambio = Number(dto.tipoCambio);
    const valorSolesRecalc = costoEnSoles(v, tipoCambio);
    const costoTotalRecalc = +(valorSolesRecalc + costoEnvioSoles).toFixed(2);

    // Persistir nuevos valores en ProductoValor
    v.valorSoles = valorSolesRecalc;
    v.costoTotal = costoTotalRecalc;
    await this.valorRepo.save(v);

    // 3) Calcular ganancia y porcentaje
    const precioVenta = Number(dto.precioVenta);
    const ganancia = +(precioVenta - costoTotalRecalc).toFixed(2);
    const porcentajeGanancia = calculateProfitPercentage(
      ganancia,
      costoTotalRecalc,
    );

    // 4) Crear venta (acepta vendedor opcional)
    const venta = this.ventaRepo.create({
      productoId: producto.id,
      tipoCambio,
      fechaVenta: dto.fechaVenta,
      precioVenta,
      ganancia,
      porcentajeGanancia,
      cantidad: 1,
      modalidad: 'unidad',
      vendedor: resolvedSeller,
    });
    const saved = await this.saveIdempotent(venta);
    await this.syncSaleIncome(saved, dto.incomeBank, dto.incomePaymentType, dto.incomeSku, dto.incomeParts, { cuentaId: dto.incomeAccountId, metodo: dto.incomeMethod });
    // invalidar KPIs de productos
    await this.cache.del?.('productos:stats').catch?.(() => {});
    await this.cache.del?.('productos:resumen').catch?.(() => {});
    return saved;
  }

  async update(id: number, dto: UpdateVentaDto): Promise<Venta> {
    this.validateSaleAmounts(dto);
    if (!this.transactionManager) return this.inTransaction((service) => service.update(id, dto));
    await this.transactionManager.query('SELECT id FROM venta WHERE id = $1 FOR UPDATE', [id]);
    const saved = await this.updateSale(id, dto);
    if (dto.precioLista != null || dto.descuento != null || dto.grupoOperacion != null) {
      this.validateFinancialFields(dto, Number(saved.precioVenta));
      return this.applyFinancialFields(saved, dto);
    }
    return saved;
  }

  private async updateSale(id: number, dto: UpdateVentaDto): Promise<Venta> {
    const venta = await this.findOne(id);
    if (venta.estadoComercial === 'cancelada' || Number(venta.cantidadDevuelta || 0) > 0) {
      throw new BadRequestException('La venta tiene devoluciones. Conserva sus datos originales y registra los ajustes en su historial financiero.');
    }
    let advanceAmount = 0;
    if ((dto.precioVenta !== undefined || dto.incomeParts !== undefined) && typeof this.adelantoRepo?.findOne === 'function') {
      const advance = await this.adelantoRepo.findOne({ where: { ventaId: id } });
      advanceAmount = Number(advance?.montoAdelanto || 0);
      if (advance && Number(dto.precioVenta) < Number(advance.montoAdelanto)) {
        throw new BadRequestException('El precio de venta no puede ser menor que los adelantos registrados.');
      }
    }
    if (dto.incomeParts !== undefined) {
      const expectedCents = Math.round(Number(dto.precioVenta ?? venta.precioVenta) * 100) - Math.round(advanceAmount * 100);
      const parts = dto.incomeParts;
      const seen = new Set<string>();
      if (!Array.isArray(parts) || !parts.length || !Number.isSafeInteger(expectedCents) || expectedCents <= 0
        || parts.some((part) => {
          const partCents = Math.round(Number(part.amount) * 100);
          if (!['direct', 'card', 'debt', 'cash'].includes(part.type) || seen.has(part.type)
            || !Number.isSafeInteger(partCents) || partCents <= 0 || Math.abs(partCents / 100 - Number(part.amount)) > 0.000001) return true;
          seen.add(part.type);
          return false;
        }) || parts.reduce((sum, part) => sum + Math.round(Number(part.amount) * 100), 0) !== expectedCents) {
        throw new BadRequestException('Las partes del cobro deben sumar el precio de la venta.');
      }
      if (parts.some((part) => part.type !== 'cash') && !dto.incomeBank) {
        throw new BadRequestException('Selecciona la cuenta de débito para el cobro.');
      }
      if (this.gastoRepo) {
        const incomes = (await this.gastoRepo.find({ where: { saleId: id, concepto: 'ingreso' } }))
          .filter((income) => !isAdvanceIncome(income));
        for (const type of ['card', 'debt'] as const) {
          const received = incomes.filter((income) => income.salePaymentType === type)
            .reduce((sum, income) => sum + Math.round(Number(income.saleReceivedAmount || 0) * 100), 0);
          if (received > Math.round(Number(parts.find((part) => part.type === type)?.amount || 0) * 100)) {
            throw new BadRequestException('El nuevo importe no puede ser menor que los pagos ya recibidos.');
          }
        }
      }
    }
    if (this.gastoRepo && dto.precioVenta !== undefined && Number(dto.precioVenta) !== Number(venta.precioVenta) && dto.incomeParts === undefined) {
      const incomes = await this.gastoRepo.find({ where: { saleId: id } });
      if (incomes.some((income) => ['direct', 'card', 'debt', 'cash'].some((type) => String(income.notas || '').endsWith(`:${type}`)))) {
        throw new BadRequestException('Para cambiar el precio de una venta con pagos combinados, indica también los nuevos importes de cobro.');
      }
    }
    const producto = await this.productoRepo.findOne({
      where: { id: venta.productoId },
      relations: ['valor'],
    });
    if (!producto?.valor)
      throw new BadRequestException(
        'El producto no tiene seccion de valor asociada',
      );
    if (isAccessoryStock(producto.tipo)) {
      if (dto.tipoCambio !== undefined) venta.tipoCambio = Number(dto.tipoCambio);
      if (dto.precioVenta !== undefined) venta.precioVenta = Number(dto.precioVenta);
      if ((dto as any).vendedor !== undefined || producto.vendedor != null) {
        venta.vendedor = (dto as any).vendedor !== undefined
          ? normalizeSellerLabel((dto as any).vendedor)
          : normalizeSellerLabel(venta.vendedor) ?? sellerFromProducto(producto, null);
      }
      if (dto.fechaVenta !== undefined) venta.fechaVenta = dto.fechaVenta;
      const distribution = venta.distribucionStock?.length
        ? venta.distribucionStock
        : [{ productoId: venta.productoId, cantidad: venta.cantidad || 1 }];
      const lotIds = [...new Set(distribution.map((row) => Number(row.productoId)))];
      const lots = await this.productoRepo.find({ where: { id: In(lotIds) }, relations: ['valor'] });
      const byId = new Map(lots.map((lot) => [lot.id, lot]));
      if (distribution.some((row) => !byId.has(Number(row.productoId)))) {
        throw new BadRequestException('No se encontró el costo de uno de los lotes vendidos.');
      }
      const cost = distribution.reduce((sum, row) =>
        sum + Number(row.costoUnitario ?? getAccessoryUnitCost(byId.get(Number(row.productoId)))) * Number(row.cantidad || 0), 0);
      venta.ganancia = +(Number(venta.precioVenta) - cost).toFixed(2);
      venta.porcentajeGanancia = calculateProfitPercentage(Number(venta.ganancia), cost);
      const saved = await this.ventaRepo.save(venta);
      await this.syncSaleIncome(saved, dto.incomeBank, dto.incomePaymentType, dto.incomeSku, dto.incomeParts, { cuentaId: dto.incomeAccountId, metodo: dto.incomeMethod });
      await this.cache.del?.('productos:stats').catch?.(() => {});
      await this.cache.del?.('productos:resumen').catch?.(() => {});
      return saved;
    }
    const resolvedSeller =
      (dto as any).vendedor !== undefined
        ? normalizeSellerLabel((dto as any).vendedor)
        : normalizeSellerLabel(venta.vendedor) ?? sellerFromProducto(producto, null);
    const nextVendedor =
      resolvedSeller ?? null;
    const splitMode =
      isSplitSeller(nextVendedor) ||
      (dto as any).tipoCambioGonzalo !== undefined ||
      (dto as any).tipoCambioRenato !== undefined;

    // Si actualizan tipoCambio o precioVenta, recomputamos con el estado ACTUAL del producto
    if (
      dto.tipoCambio !== undefined ||
      dto.precioVenta !== undefined ||
      (dto as any).tipoCambioGonzalo !== undefined ||
      (dto as any).tipoCambioRenato !== undefined
    ) {
      const precioVenta =
        dto.precioVenta !== undefined
          ? Number(dto.precioVenta)
          : Number(venta.precioVenta);

      const v = producto.valor;
      const costoEnvioSoles = Number(
        (v as any).costoEnvioProrrateado ?? v.costoEnvio ?? 0,
      );

      if (splitMode) {
        const tipoCambioGonzalo = Number(
          (dto as any).tipoCambioGonzalo ??
            venta.tipoCambioGonzalo ??
            venta.tipoCambio ??
            dto.tipoCambio,
        );
        const tipoCambioRenato = Number(
          (dto as any).tipoCambioRenato ??
            venta.tipoCambioRenato ??
            venta.tipoCambio ??
            dto.tipoCambio,
        );
        if (!tipoCambioGonzalo || !tipoCambioRenato) {
          throw new BadRequestException(
            'Tipo de cambio invalido para venta conjunta.',
          );
        }

        const { total, valorSoles } = calcSplitCosts(v, costoEnvioSoles, tipoCambioGonzalo, tipoCambioRenato);

        v.valorSoles = valorSoles;
        v.costoTotal = total;
        await this.valorRepo.save(v);

        const avgTc = +(((tipoCambioGonzalo + tipoCambioRenato) / 2).toFixed(4));
        venta.tipoCambio = avgTc;
        venta.tipoCambioGonzalo = tipoCambioGonzalo;
        venta.tipoCambioRenato = tipoCambioRenato;
        venta.precioVenta = precioVenta;
        venta.ganancia = +(precioVenta - total).toFixed(2);
        venta.porcentajeGanancia = calculateProfitPercentage(
          Number(venta.ganancia),
          total,
        );
      } else {
        const tipoCambio =
          dto.tipoCambio !== undefined
            ? Number(dto.tipoCambio)
            : Number(venta.tipoCambio);

        const valorSolesRecalc = costoEnSoles(v, tipoCambio);
        const costoTotalRecalc = +(
          valorSolesRecalc +
          Number((v as any).costoEnvioProrrateado ?? v.costoEnvio ?? 0)
        ).toFixed(2);

        v.valorSoles = valorSolesRecalc;
        v.costoTotal = costoTotalRecalc;
        await this.valorRepo.save(v);

        venta.tipoCambio = tipoCambio;
        venta.tipoCambioGonzalo = null;
        venta.tipoCambioRenato = null;
        venta.precioVenta = precioVenta;
        venta.ganancia = +(precioVenta - costoTotalRecalc).toFixed(2);
        venta.porcentajeGanancia = calculateProfitPercentage(
          Number(venta.ganancia),
          costoTotalRecalc,
        );
      }
    }
    // permitir asignar vendedor
    if ((dto as any).vendedor !== undefined || producto?.vendedor != null) {
      // guardar string o null si viene vacío
      venta.vendedor = resolvedSeller;
    }

    if (dto.fechaVenta !== undefined) venta.fechaVenta = dto.fechaVenta;

    const saved = await this.ventaRepo.save(venta);
    await this.syncSaleIncome(saved, dto.incomeBank, dto.incomePaymentType, dto.incomeSku, dto.incomeParts, { cuentaId: dto.incomeAccountId, metodo: dto.incomeMethod });
    await this.cache.del?.('productos:stats').catch?.(() => {});
    await this.cache.del?.('productos:resumen').catch?.(() => {});
    return saved;
  }

  listarDevoluciones(id: number) {
    return this.ventaRepo.manager.getRepository(VentaDevolucion).find({ where: { ventaId: id }, order: { id: 'ASC' } });
  }

  async devolver(id: number, dto: DevolverVentaDto, userId?: number): Promise<VentaDevolucion> {
    if (!this.transactionManager) return this.inTransaction((service) => service.devolver(id, dto, userId));
    const manager = this.transactionManager;
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`devolucion:${dto.operacionKey}`]);
    const repo = manager.getRepository(VentaDevolucion);
    const hash = operationHash({ id, ...dto });
    const previous = await repo.findOneBy({ operacionKey: dto.operacionKey });
    if (previous) {
      if (previous.operacionHash !== hash) throw new ConflictException('La clave de devolución ya se utilizó con otros datos.');
      return previous;
    }
    await manager.query('SELECT id FROM venta WHERE id = $1 FOR UPDATE', [id]);
    const venta = await this.findOne(id);
    if (venta.estadoComercial === 'cancelada') throw new BadRequestException('La venta ya está devuelta.');
    if (dto.fecha < String(venta.fechaVenta).slice(0, 10)) throw new BadRequestException('La devolución no puede ser anterior a la venta.');
    const anteriores = await repo.findBy({ ventaId: id });
    const devueltas = anteriores.reduce((sum, row) => sum + row.cantidad, 0);
    const cantidadTotal = Number(venta.cantidad || 1);
    if (!Number.isInteger(dto.cantidad) || dto.cantidad < 1 || dto.cantidad + devueltas > cantidadTotal) throw new BadRequestException('Cantidad devuelta superior a las unidades vendidas pendientes.');
    const pagos = await manager.getRepository(VentaPago).find({ where: { ventaId: id, anuladoAt: IsNull() }, relations: ['liquidaciones'], order: { id: 'ASC' } });
    const disponibles = pagos.map((pago) => {
      const r = resumenPago(toPagoCalc(pago));
      return { pago, cents: toCents(pago.montoPen) - r.devueltoCents - r.contracargoCents + r.reversionCents };
    });
    let pendiente = toCents(dto.monto);
    if (pendiente < 0 || pendiente > disponibles.reduce((sum, p) => sum + Math.max(0, p.cents), 0)) throw new BadRequestException('El importe supera el dinero cobrado que puede devolverse.');
    if (pendiente && !dto.cuentaId) throw new BadRequestException('Selecciona la cuenta de la que sale el dinero.');
    if (devueltas + dto.cantidad === cantidadTotal && pendiente !== disponibles.reduce((sum, p) => sum + Math.max(0, p.cents), 0)) {
      throw new BadRequestException('Para devolver toda la venta, registra también la devolución del dinero cobrado pendiente.');
    }
    if (dto.cuentaId) {
      const cuenta = await manager.getRepository(CuentaFinanciera).findOneBy({ id: dto.cuentaId });
      if (!cuenta?.activo || cuenta.moneda !== 'PEN' || !['banco', 'billetera', 'efectivo'].includes(cuenta.tipo)) throw new BadRequestException('La devolución debe salir de una cuenta propia activa en soles.');
    }
    for (const { pago, cents } of disponibles) {
      if (pendiente <= 0) break;
      const amount = Math.min(pendiente, Math.max(0, cents));
      if (!amount) continue;
      if (!this.ledger) throw new BadRequestException('Libro financiero no disponible.');
      await this.ledger.registrarEvento(pago.id, { tipo: 'devolucion', fecha: dto.fecha, montoBruto: amount / 100,
        cuentaId: dto.cuentaId, nota: dto.motivo, idempotencyKey: `${dto.operacionKey}:${pago.id}` }, manager);
      pendiente -= amount;
    }
    const usados = new Map<number, number>();
    anteriores.flatMap((row) => row.lotes).forEach((row) => usados.set(row.productoId, (usados.get(row.productoId) || 0) + row.cantidad));
    const distribucion = venta.distribucionStock?.length ? venta.distribucionStock
      : [{ productoId: venta.productoId, cantidad: cantidadTotal, costoUnitario: (Number(venta.precioVenta) - Number(venta.ganancia)) / cantidadTotal }];
    const ids = [...new Set(distribucion.map((row) => row.productoId))].sort((a, b) => a - b);
    await manager.query('SELECT id FROM producto WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [ids]);
    let unidades = dto.cantidad; let costoRecuperado = 0;
    const lotes: VentaDevolucion['lotes'] = [];
    for (const part of distribucion) {
      const take = Math.min(unidades, part.cantidad - (usados.get(part.productoId) || 0));
      if (take <= 0) continue;
      const producto = await this.productoRepo.findOneBy({ id: part.productoId });
      if (!producto) throw new BadRequestException('No existe el lote original de la venta.');
      const unit = Number(part.costoUnitario ?? getAccessoryUnitCost(producto));
      lotes.push({ productoId: part.productoId, cantidad: take, costoUnitario: unit });
      if (dto.destino === 'disponible') {
        if (isAccessoryStock(producto.tipo)) producto.stockActual = Number(producto.stockActual) + take;
        producto.cierreMotivo = null;
        costoRecuperado += unit * take;
      } else if (!isAccessoryStock(producto.tipo)) producto.cierreMotivo = 'no_comercializable';
      await this.productoRepo.save(producto);
      unidades -= take;
      if (!unidades) break;
    }
    if (unidades) throw new BadRequestException('La distribución original de lotes no cubre la devolución.');
    venta.costoDevuelto = Number(venta.costoDevuelto || 0) + Number(costoRecuperado.toFixed(2));
    const precioAnulado = devueltas + dto.cantidad === cantidadTotal
      ? toCents(venta.precioVenta) - toCents(venta.precioDevuelto)
      : Math.round(toCents(venta.precioVenta) * dto.cantidad / cantidadTotal);
    venta.precioDevuelto = (toCents(venta.precioDevuelto) + precioAnulado) / 100;
    venta.cantidadDevuelta = devueltas + dto.cantidad;
    if (devueltas + dto.cantidad === cantidadTotal) venta.estadoComercial = 'cancelada';
    await this.ventaRepo.save(venta);
    const saved = await repo.save(repo.create({ ...dto, ventaId: id, userId: userId || null, monto: Number(dto.monto).toFixed(2),
      costoRecuperado: costoRecuperado.toFixed(2), precioAnulado: (precioAnulado / 100).toFixed(2), operacionHash: hash, lotes }));
    if (toCents(dto.monto) > 0 && this.gastoRepo) {
      const ingresos = await this.gastoRepo.find({ where: { saleId: id, concepto: 'ingreso' } });
      const propietarios = new Map<number, number>();
      ingresos.forEach((row) => propietarios.set(row.userId, (propietarios.get(row.userId) || 0) + toCents(row.monto)));
      if (!propietarios.size && userId) propietarios.set(userId, 1);
      const peso = [...propietarios.values()].reduce((sum, amount) => sum + amount, 0);
      const cuenta = await manager.getRepository(CuentaFinanciera).findOneByOrFail({ id: dto.cuentaId });
      let asignado = 0;
      for (const [index, [owner, amount]] of [...propietarios].entries()) {
        const cents = index === propietarios.size - 1 ? toCents(dto.monto) - asignado : Math.round(toCents(dto.monto) * amount / peso);
        asignado += cents;
        if (!cents) continue;
        await this.gastoRepo.save(this.gastoRepo.create({ userId: owner, concepto: 'devolucion_venta', metodoPago: 'debito',
          moneda: 'PEN', monto: (cents / 100).toFixed(2), montoPen: (cents / 100).toFixed(2), fecha: dto.fecha,
          tarjeta: cuenta.legacyCodigo || cuenta.codigo, saleId: id,
          notas: `__REFUND__:VENTA:${id}:${saved.id}`, clasificacionFinanciera: 'ajuste_devolucion' }));
      }
    }
    await this.cache.del?.('productos:stats').catch?.(() => {});
    await this.cache.del?.('productos:resumen').catch?.(() => {});
    return saved;
  }

  async remove(id: number, motivo?: string): Promise<void> {
    if (!this.transactionManager) return this.inTransaction((service) => service.remove(id, motivo));
    await this.transactionManager.query('SELECT id FROM venta WHERE id = $1 FOR UPDATE', [id]);
    const venta = await this.ventaRepo.findOne({ where: { id }, relations: ['producto'] });
    if (!venta) return;
    const pagos = this.ledger ? await this.transactionManager.getRepository(VentaPago).count({ where: { ventaId: id, anuladoAt: IsNull() } }) : 0;
    const ingresos = this.gastoRepo ? await this.gastoRepo.find({ where: { saleId: id } }) : [];
    const cobrado = ingresos.some((row) => Number(row.saleReceivedAmount || 0) > 0 || row.monto && (!row.salePaymentType || ['direct', 'cash'].includes(row.salePaymentType)));
    if (venta.estadoComercial === 'entregada' || pagos || cobrado) throw new BadRequestException('La venta tiene cobros o entrega. Registra una devolución con importe, fecha, cuenta y destino físico.');
    if (!motivo || motivo.trim().length < 3) throw new BadRequestException('Indica el motivo de la corrección de digitación.');
    if (isAccessoryStock(venta.producto?.tipo)) {
      const distribution = Array.isArray(venta.distribucionStock)
        ? venta.distribucionStock.filter((row) => Number(row?.productoId) && Number(row?.cantidad) > 0)
        : [];
      const ids = [...new Set(distribution.length ? distribution.map((row) => Number(row.productoId)) : [venta.productoId || venta.producto.id])].sort((a, b) => a - b);
      await this.transactionManager.query('SELECT id FROM producto WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [ids]);
      if (distribution.length) {
        for (const row of distribution) {
          const lot = await this.productoRepo.findOne({ where: { id: Number(row.productoId) } });
          if (!lot) continue;
          lot.stockActual = Math.min(
            Number(lot.stockInicial || 0),
            Number(lot.stockActual || 0) + Number(row.cantidad),
          );
          await this.productoRepo.save(lot);
        }
      } else {
        venta.producto.stockActual = Math.min(
          Number(venta.producto.stockInicial || 0),
          Number(venta.producto.stockActual || 0) + Number(venta.cantidad || 1),
        );
        await this.productoRepo.save(venta.producto);
      }
    }
    await this.ventaRepo.remove(venta);
    await this.ledger?.marcarVentaEliminada(id, this.transactionManager);
    if (this.gastoRepo) {
      const linkedIncome = await this.gastoRepo.find({ where: { saleId: id } });
      if (linkedIncome.length) await this.gastoRepo.remove(linkedIncome);
    }
    await this.cache.del?.('productos:stats').catch?.(() => {});
    await this.cache.del?.('productos:resumen').catch?.(() => {});
  }
}

