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
import { ILike, In, IsNull, Repository } from 'typeorm';
import { Venta } from './venta.entity';
import { VentaAdelanto } from './venta-adelanto.entity';
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
import { User } from '../auth/entities/user.entity';
import { formatAppleWatchName } from '../common/product-name.util';

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
  if (value.includes('charger') || value.includes('cargador') || value.includes('adaptador')) return 'cargador';
  if (value.includes('cable')) return 'cable';
  if (value.includes('case') || value.includes('funda')) return 'case';
  if (value.includes('correa') || value.includes('band')) return 'correa';
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

const calcSplitCosts = (usdTotal: number, envioSoles: number, tcG: number, tcR: number) => {
  const halfUsd = usdTotal / 2;
  const halfEnvio = envioSoles / 2;
  const costoG = +(halfUsd * tcG + halfEnvio).toFixed(2);
  const costoR = +(halfUsd * tcR + halfEnvio).toFixed(2);
  const total = +(costoG + costoR).toFixed(2);
  const valorSoles = +(usdTotal * ((tcG + tcR) / 2)).toFixed(2);
  return { costoG, costoR, total, valorSoles };
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
  ) {}

  private async resolveIncomeUser(owner: 'gonzalo' | 'renato'): Promise<User | null> {
    if (!this.userRepo) return null;
    const named = await this.userRepo.findOne({ where: { username: ILike(`%${owner}%`) } });
    if (named) return named;
    return owner === 'gonzalo' ? this.userRepo.findOne({ where: { role: 'admin' } }) : null;
  }

  private async syncAdelantoIncome(adelanto: VentaAdelanto, producto?: Producto | null): Promise<void> {
    if (!this.gastoRepo || !this.userRepo) return;
    const seller = normalizeSeller(producto?.vendedor || adelanto.producto?.vendedor);
    const owners: Array<'gonzalo' | 'renato'> = seller === 'ambos'
      ? ['gonzalo', 'renato']
      : seller === 'renato' ? ['renato']
        : seller === 'gonzalo' || seller.startsWith('gonzalo (') ? ['gonzalo'] : [];
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

    let accessorySale = isAccessoryStock(venta.producto?.tipo);
    if (!accessorySale && typeof (this.productoRepo as any).findOne === 'function') {
      const productType = await this.productoRepo.findOne({ where: { id: venta.productoId }, select: ['id', 'tipo'] });
      accessorySale = isAccessoryStock(productType?.tipo);
    }
    // Cada salida de stock es una venta distinta y necesita su propio ingreso.
    const reference = accessorySale
      ? `__SALE_INCOME__:${venta.productoId}:${venta.id}`
      : `__SALE_INCOME__:${venta.productoId}`;
    const linked = await this.gastoRepo.find({
      where: {
        concepto: 'ingreso',
        metodoPago: 'debito',
        notas: In([reference, String(venta.productoId), ...(['direct', 'card', 'debt', 'cash'].map((type) => `${reference}:${type}`))]),
      },
      order: { id: 'ASC' },
    });
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
    if (submittedParts === undefined && linked.some((row) => String(row.notas).startsWith(`${reference}:`))) {
      submittedParts = (['direct', 'card', 'debt', 'cash'] as const).map((type) => ({
        type,
        amount: linked.filter((row) => row.salePaymentType === type).reduce((sum, row) => sum + Number(row.monto || 0), 0),
      })).filter((part) => part.amount > 0);
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
          const existingPart = linked.find((row) => row.userId === user.id && row.notas === partReference);
          const isReceived = part.type === 'direct' || part.type === 'cash';
          const values = {
            userId: user.id,
            concepto: 'ingreso',
            metodoPago: 'debito' as const,
            moneda: 'PEN' as const,
            monto: (partCents / 100).toFixed(2),
            montoPen: (partCents / 100).toFixed(2),
            fecha: String(venta.fechaVenta || '').slice(0, 10),
            tarjeta: part.type === 'cash' ? 'efectivo' : incomeBank || existingPart?.tarjeta || 'bcp',
            tarjetaPago: null,
            notas: partReference,
            saleId: venta.id,
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
      const existing = linked.find((row) => row.userId === user.id && !String(row.notas).startsWith(`${reference}:`));
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
    input: { paymentAmount?: number; paymentCount?: number; paidAt?: string; exchangeRate?: number },
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
      history.push({ amount: paymentCents / 100, paidAt: input.paidAt!, ...(hasCount ? { units500: input.paymentCount } : {}) });
    }
    const nextReceivedCents = receivedCents + paymentCents;
    income.salePaymentHistory = history;
    income.saleReceivedAmount = (nextReceivedCents / 100).toFixed(2);
    income.cantidad500 = income.salePaymentType === 'debt'
      ? history.reduce((sum, payment) => sum + Number(payment.units500 || 0), 0)
      : null;
    income.salePaidAt = history.at(-1)?.paidAt || null;
    if (nextReceivedCents === totalCents && income.saleExchangeRate && income.saleId) {
      const rate = Number(income.saleExchangeRate);
      const sale = await this.findOne(income.saleId);
      await this.update(income.saleId, isSplitSeller(normalizeSeller(sale.vendedor))
        ? { tipoCambio: rate, tipoCambioGonzalo: rate, tipoCambioRenato: rate }
        : { tipoCambio: rate });
      income.tasaUsdPen = rate.toFixed(4);
    }
    return this.gastoRepo.save(income);
  }

  private async findExistingByProducto(productoId: number): Promise<Venta | null> {
    return this.ventaRepo.findOne({
      where: { productoId },
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

    return qb
      .orderBy('v.fechaVenta', 'DESC')
      .addOrderBy('v.id', 'DESC')
      .getMany();
  }

  async findByProducto(productoId: number): Promise<Venta[]> {
    return this.ventaRepo.find({
      where: { productoId },
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

    const limit = Math.min(20, Math.max(1, Number(requestedLimit) || 8));
    const candidates = await this.ventaRepo
      .createQueryBuilder('v')
      .leftJoinAndSelect('v.producto', 'p')
      .leftJoinAndSelect('p.detalle', 'det')
      .leftJoinAndSelect('p.tracking', 'trk')
      .where('LOWER(p.tipo) = LOWER(:tipo)', { tipo: reference.tipo })
      .andWhere('v.productoId <> :productoId', { productoId })
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

    return qb.getMany();
  }

  async findLatestAdelantosByProductos(productoIds?: number[]): Promise<VentaAdelanto[]> {
    const qb = this.adelantoRepo
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.producto', 'producto')
      .where('a.completadoAt IS NULL')
      .distinctOn(['a.productoId'])
      .orderBy('a.productoId', 'ASC')
      .addOrderBy('a.createdAt', 'DESC')
      .addOrderBy('a.id', 'DESC');

    if (productoIds?.length) {
      qb.andWhere('a.productoId IN (:...productoIds)', { productoIds });
    }

    const adelantos = await qb.getMany();
    for (const adelanto of adelantos) await this.syncAdelantoIncome(adelanto, adelanto.producto);
    return adelantos;
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
      if (adelanto.completadoAt || soldProductIds.has(adelanto.productoId)) continue;
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
    const producto = await this.productoRepo.findOne({
      where: { id: dto.productoId },
    });
    if (!producto)
      throw new NotFoundException(`Producto ${dto.productoId} no encontrado`);

    const existingVenta = await this.ventaRepo.findOne({
      where: { productoId: producto.id },
      order: { id: 'DESC' },
    });
    if (existingVenta) {
      throw new BadRequestException('El producto ya tiene una venta registrada.');
    }

    const existingAdelanto = await this.adelantoRepo.findOne({
      where: { productoId: producto.id, completadoAt: IsNull() },
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

  async addAdelantoCuota(
    id: number,
    dto: AddVentaAdelantoCuotaDto,
  ): Promise<VentaAdelanto> {
    const adelanto = await this.adelantoRepo.findOne({ where: { id } });
    if (!adelanto) throw new NotFoundException(`Adelanto ${id} no encontrado`);
    if (adelanto.completadoAt) {
      throw new BadRequestException(
        'No se puede agregar otro adelanto a una venta completada.',
      );
    }

    const montoCuota = +Number(dto.montoCuota).toFixed(2);
    const montoActual = +Number(adelanto.montoAdelanto || 0).toFixed(2);
    const montoVenta = +Number(adelanto.montoVenta || 0).toFixed(2);
    const nuevoTotal = +(montoActual + montoCuota).toFixed(2);

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
    return saved;
  }

  async completeAdelanto(id: number, dto: CompleteVentaAdelantoDto): Promise<Venta> {
    const adelanto = await this.adelantoRepo.findOne({ where: { id } });
    if (!adelanto) throw new NotFoundException(`Adelanto ${id} no encontrado`);
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
    const valorSolesRecalc = +(valorProductoUSD * tipoCambio).toFixed(2);
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
    const validLots = lots.filter((lot) => isAccessoryStock(lot.tipo));
    const lotIds = validLots.map((lot) => lot.id);
    const sales = lotIds.length
      ? await this.ventaRepo.find({
          where: { productoId: In(lotIds) },
          order: { fechaVenta: 'ASC', id: 'ASC' },
        })
      : [];

    const lotsById = new Map(validLots.map((lot) => [Number(lot.id), lot]));
    let unidadesVendidas = 0;
    let ventaBruta = 0;
    let costoVendido = 0;
    let weightedTc = 0;
    const detalleVentas = sales.map((sale) => {
      const cantidad = Math.max(1, Number(sale.cantidad || 1));
      const distribution = Array.isArray(sale.distribucionStock) && sale.distribucionStock.length
        ? sale.distribucionStock
        : [{ productoId: sale.productoId, cantidad }];
      const bruto = Number(sale.precioVenta || 0);
      const costo = distribution.reduce((sum, item) => {
        const lot = lotsById.get(Number(item.productoId));
        if (!lot?.valor) return sum;
        const totalLotCost = Number(lot.valor.costoTotalProrrateado ?? lot.valor.costoTotal ?? lot.valor.valorSoles ?? 0);
        const unitCost = totalLotCost / Math.max(1, Number(lot.stockInicial || 1));
        return sum + unitCost * Math.max(0, Number(item.cantidad || 0));
      }, 0);
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
        costo: +costo.toFixed(2),
        gananciaNeta: +gananciaNeta.toFixed(2),
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
      costoVendido: +costoVendido.toFixed(2),
      gananciaNeta: +(ventaBruta - costoVendido).toFixed(2),
      tipoCambioPromedio: unidadesVendidas ? +(weightedTc / unidadesVendidas).toFixed(4) : null,
      ventas: detalleVentas.reverse(),
    };
  }

  async create(dto: CreateVentaDto): Promise<Venta> {
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
      await this.syncSaleIncome(existing, dto.incomeBank, dto.incomePaymentType, dto.incomeSku, dto.incomeParts);
      return existing;
    }

    // 1) Cargar producto con valor
    const producto = await this.productoRepo.findOne({
      where: { id: dto.productoId },
      relations: ['valor'],
    });
    if (!producto)
      throw new NotFoundException(`Producto ${dto.productoId} no encontrado`);
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
          .setLock('pessimistic_write')
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
        const groupLots = groupCandidates.filter((candidate) => isAccessoryStock(candidate.tipo));
        const locked = groupLots.find((lot) => lot.id === producto.id);
        if (!locked?.valor) throw new BadRequestException('El accesorio no tiene costo asociado.');
        groupLots.sort((a, b) => getAccessoryLotDate(a) - getAccessoryLotDate(b) || a.id - b.id);
        const availableStock = groupLots.reduce(
          (sum, lot) => sum + Math.max(0, Number(lot.stockActual || 0)),
          0,
        );
        if (availableStock < cantidad) {
          throw new BadRequestException(`Stock insuficiente. Quedan ${availableStock} unidades.`);
        }
        const precioVenta = Number(dto.precioVenta);
        let pending = cantidad;
        const distribucionStock: Array<{ productoId: number; cantidad: number }> = [];
        for (const lot of groupLots) {
          if (pending <= 0) break;
          const taken = Math.min(Math.max(0, Number(lot.stockActual || 0)), pending);
          if (!taken) continue;
          lot.stockActual = Number(lot.stockActual) - taken;
          pending -= taken;
          distribucionStock.push({ productoId: lot.id, cantidad: taken });
          await manager.getRepository(Producto).save(lot);
        }
        return manager.getRepository(Venta).save(manager.getRepository(Venta).create({
          productoId: locked.id,
          tipoCambio,
          fechaVenta: dto.fechaVenta,
          precioVenta,
          cantidad,
          modalidad,
          distribucionStock,
          ganancia: 0,
          porcentajeGanancia: 0,
          vendedor: normalizeSellerLabel(dto.vendedor) ?? sellerFromProducto(locked, null),
        }));
      });
      await this.syncSaleIncome(saved, dto.incomeBank, dto.incomePaymentType, dto.incomeSku, dto.incomeParts);
      await this.cache.del?.('productos:stats').catch?.(() => {});
      await this.cache.del?.('productos:resumen').catch?.(() => {});
      return saved;
    }

    // Los equipos son unidades únicas; los reintentos devuelven la misma fila.
    const v = producto.valor;
    const resolvedSeller =
      normalizeSellerLabel((dto as any).vendedor) ?? sellerFromProducto(producto, null);

    // 2) Recalcular costos con el tipo de cambio ingresado
    const valorProductoUSD = Number(v.valorProducto); // USD
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

      const { total, valorSoles } = calcSplitCosts(
        valorProductoUSD,
        costoEnvioSoles,
        tipoCambioGonzalo,
        tipoCambioRenato,
      );

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
      await this.syncSaleIncome(saved, dto.incomeBank, dto.incomePaymentType, dto.incomeSku, dto.incomeParts);
      // invalidar KPIs de productos
      await this.cache.del?.('productos:stats').catch?.(() => {});
      return saved;
    }

    const tipoCambio = Number(dto.tipoCambio);
    const valorSolesRecalc = +(valorProductoUSD * tipoCambio).toFixed(2);
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
    await this.syncSaleIncome(saved, dto.incomeBank, dto.incomePaymentType, dto.incomeSku, dto.incomeParts);
    // invalidar KPIs de productos
    await this.cache.del?.('productos:stats').catch?.(() => {});
    await this.cache.del?.('productos:resumen').catch?.(() => {});
    return saved;
  }

  async update(id: number, dto: UpdateVentaDto): Promise<Venta> {
    const venta = await this.findOne(id);
    if (dto.precioVenta !== undefined && typeof this.adelantoRepo?.findOne === 'function') {
      const advance = await this.adelantoRepo.findOne({ where: { ventaId: id } });
      if (advance && Number(dto.precioVenta) < Number(advance.montoAdelanto)) {
        throw new BadRequestException('El precio de venta no puede ser menor que los adelantos registrados.');
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
      venta.ganancia = 0;
      venta.porcentajeGanancia = 0;
      const saved = await this.ventaRepo.save(venta);
      await this.syncSaleIncome(saved, dto.incomeBank, dto.incomePaymentType, dto.incomeSku, dto.incomeParts);
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
      const valorProductoUSD = Number(v.valorProducto);
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

        const { total, valorSoles } = calcSplitCosts(
          valorProductoUSD,
          costoEnvioSoles,
          tipoCambioGonzalo,
          tipoCambioRenato,
        );

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

        const valorSolesRecalc = +(valorProductoUSD * tipoCambio).toFixed(2);
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
    await this.syncSaleIncome(saved, dto.incomeBank, dto.incomePaymentType, dto.incomeSku, dto.incomeParts);
    await this.cache.del?.('productos:stats').catch?.(() => {});
    await this.cache.del?.('productos:resumen').catch?.(() => {});
    return saved;
  }

  async remove(id: number): Promise<void> {
    const venta = await this.ventaRepo.findOne({ where: { id }, relations: ['producto'] });
    if (!venta) throw new NotFoundException(`Venta ${id} no encontrada`);
    if (isAccessoryStock(venta.producto?.tipo)) {
      const distribution = Array.isArray(venta.distribucionStock)
        ? venta.distribucionStock.filter((row) => Number(row?.productoId) && Number(row?.cantidad) > 0)
        : [];
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
    if (this.gastoRepo) {
      const linkedIncome = await this.gastoRepo.find({ where: { saleId: id } });
      if (linkedIncome.length) await this.gastoRepo.remove(linkedIncome);
    }
    await this.cache.del?.('productos:stats').catch?.(() => {});
    await this.cache.del?.('productos:resumen').catch?.(() => {});
  }
}

