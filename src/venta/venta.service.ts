import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Venta } from './venta.entity';
import { VentaAdelanto } from './venta-adelanto.entity';
import { CreateVentaDto } from './dto/create-venta.dto';
import { UpdateVentaDto } from './dto/update-venta.dto';
import { CreateVentaAdelantoDto } from './dto/create-venta-adelanto.dto';
import { CompleteVentaAdelantoDto } from './dto/complete-venta-adelanto.dto';
import { AddVentaAdelantoCuotaDto } from './dto/add-venta-adelanto-cuota.dto';
import { Producto } from '../producto/producto.entity';
import { ProductoValor } from '../producto/producto-valor.entity';
import { calculateProfitPercentage } from './venta-profit.utils';

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
    return [
      'Apple Watch',
      detalle.gama,
      detalle.generacion,
      detalle.tamano || detalle['tamaño'] || detalle.tamanio,
      detalle.conexion,
    ]
      .filter(Boolean)
      .join(' ');
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
  ) {}

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
    const sameWhenPresent = (candidateDetail: any, key: string) => {
      const expected = normalizeComparable(referenceDetail[key]);
      return !expected || normalizeComparable(candidateDetail?.[key]) === expected;
    };

    const similar = candidates.filter((sale) => {
      const candidateDetail: any = sale.producto?.detalle || {};
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
      .where('a.completadoAt IS NULL')
      .distinctOn(['a.productoId'])
      .orderBy('a.productoId', 'ASC')
      .addOrderBy('a.createdAt', 'DESC')
      .addOrderBy('a.id', 'DESC');

    if (productoIds?.length) {
      qb.andWhere('a.productoId IN (:...productoIds)', { productoIds });
    }

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
      cuotas: [{ fecha: dto.fechaAdelanto, monto: montoAdelanto }],
    });
    return this.adelantoRepo.save(adelanto);
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
    cuotas.push({ fecha: dto.fechaCuota, monto: montoCuota });

    adelanto.cuotas = cuotas;
    adelanto.montoAdelanto = nuevoTotal;
    return this.adelantoRepo.save(adelanto);
  }

  async completeAdelanto(id: number, dto: CompleteVentaAdelantoDto): Promise<Venta> {
    const adelanto = await this.adelantoRepo.findOne({ where: { id } });
    if (!adelanto) throw new NotFoundException(`Adelanto ${id} no encontrado`);
    if (adelanto.completadoAt) {
      throw new BadRequestException('El adelanto ya fue completado.');
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
    await this.cache.del?.('productos:stats').catch?.(() => {});
    return saved;
  }

  async findOne(id: number): Promise<Venta> {
    const v = await this.ventaRepo.findOne({ where: { id } });
    if (!v) throw new NotFoundException(`Venta ${id} no encontrada`);
    return v;
  }

  async create(dto: CreateVentaDto): Promise<Venta> {
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
        vendedor:
          normalizeSellerLabel((dto as any).vendedor) ??
          sellerFromProducto(producto, 'ambos'),
      });
      const saved = await this.ventaRepo.save(venta);
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
      vendedor: resolvedSeller,
    });
    const saved = await this.ventaRepo.save(venta);
    // invalidar KPIs de productos
    await this.cache.del?.('productos:stats').catch?.(() => {});
    return saved;
  }

  async update(id: number, dto: UpdateVentaDto): Promise<Venta> {
    const venta = await this.findOne(id);
    const producto = await this.productoRepo.findOne({
      where: { id: venta.productoId },
      relations: ['valor'],
    });
    if (!producto?.valor)
      throw new BadRequestException(
        'El producto no tiene seccion de valor asociada',
      );
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
    await this.cache.del?.('productos:stats').catch?.(() => {});
    return saved;
  }

  async remove(id: number): Promise<void> {
    const venta = await this.ventaRepo.findOne({ where: { id } });
    if (!venta) throw new NotFoundException(`Venta ${id} no encontrada`);
    await this.ventaRepo.remove(venta);
    await this.cache.del?.('productos:stats').catch?.(() => {});
  }
}

