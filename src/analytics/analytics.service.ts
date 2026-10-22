import { appCacheKey, invalidateProductos } from '../common/app-cache';
import { Injectable, Inject, Optional } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Cache } from 'cache-manager';
import { Producto } from '../producto/producto.entity';
import { ProductoValor } from '../producto/producto-valor.entity';
import { ProductoDetalle } from '../producto/producto-detalle.entity';
import { Tracking } from '../tracking/tracking.entity';
import { Venta } from '../venta/venta.entity';
import { Gasto } from '../gastos/entities/gasto.entity';
import { In } from 'typeorm';
import { aggregateProfitByPeriod, type GroupBy, type ProfitInput } from './profit.utils';
import { financialTotals, productCost, roundMoney, saleAmounts, saleCost } from './financial-core';
import { formatAppleWatchModel, formatAppleWatchName } from '../common/product-name.util';
import {
  buildInsights,
  computeDeltas,
  computePreviousRange,
  type CompareMetric,
} from './profit-compare.utils';

type Params = {
  fromCompra?: string;
  toCompra?: string;
  fromVenta?: string;
  toVenta?: string;
  tipo?: string;
  gama?: string;
  procesador?: string;
  pantalla?: string;
  estadoTracking?: string;
  vendedor?: string;
  transportista?: string;
  casillero?: string;
  lateDays?: number; // default 20
  aging15?: number; // default 15
  aging30?: number; // default 30
  aging60?: number; // default 60
  marginThreshold?: number; // default 15
};

type ProfitParams = {
  from?: string;
  to?: string;
  groupBy?: GroupBy;
  tipo?: string;
  gama?: string;
  procesador?: string;
  pantalla?: string;
  vendedor?: string;
  type?: string;
};

type FinancialParams = ProfitParams & { estado?: string; ram?: string; ssd?: string; estadoTracking?: string; groupBy?: GroupBy; budget?: number; strategy?: 'profit' | 'speed' | 'balanced' };

type ProductAttrs = {
  tipo: string;
  gama: string;
  proc: string;
  pantalla: string;
  ram: string;
  ssd: string;
};

type AnalyticsUniverse = {
  productos: Producto[];
  ventas: Venta[];
  vendidosHistoricosIds: number[];
};

function parseDate(d?: string): Date | null {
  if (!d) return null;
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? null : dt;
}

function daysBetween(a?: string | Date | null, b?: string | Date | null): number | null {
  if (!a || !b) return null;
  const da = typeof a === 'string' ? new Date(a) : a;
  const db = typeof b === 'string' ? new Date(b) : b;
  if (isNaN(da.getTime()) || isNaN(db.getTime())) return null;
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

function businessToday(): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function mean(nums: number[]): number | null {
  if (!nums.length) return null;
  return +(nums.reduce((s, n) => s + n, 0) / nums.length).toFixed(2);
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const arr = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  const m = arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
  return +m.toFixed(2);
}

function groupBy<T, K extends string | number>(data: T[], key: (t: T) => K) {
  const map = new Map<K, T[]>();
  data.forEach((x) => {
    const k = key(x);
    const arr = map.get(k) || [];
    arr.push(x);
    map.set(k, arr);
  });
  return map;
}

function sanitizeAttrKey(s: string) {
  return s?.toString()?.toLowerCase()?.normalize('NFD')?.replace(/[\u0300-\u036f]/g, '') || '';
}

function extractProductAttrs(p: Producto): ProductAttrs {
  let tipoP = (p.tipo || '').toLowerCase().trim();
  if (tipoP.includes('watch')) tipoP = 'watch';

  const d: any = p.detalle || {};
  let gama = d?.gama ? String(d.gama).trim() : '';
  let proc = '';
  for (const key of Object.keys(d || {})) {
    const k = sanitizeAttrKey(key);
    if (k.includes('procesador') || k === 'cpu' || k.includes('chip') || k.startsWith('proc')) {
      proc = String(d[key] ?? '');
      break;
    }
  }
  proc = proc ? proc.replace(/\s+/g, ' ').trim() : '';

  let pantalla = '';
  const known = ['10.2', '10.9', '11', '12.9', '13', '14', '15', '16'];
  for (const key of Object.keys(d || {})) {
    const k = sanitizeAttrKey(key);
    if (
      k.includes('tamano') ||
      k.includes('tamanio') ||
      k.includes('tamanopantalla') ||
      k.includes('pantalla') ||
      k.includes('screen') ||
      k.includes('size') ||
      k === 'tam'
    ) {
      pantalla = String(d[key] ?? '');
      break;
    }
  }
  if (!pantalla) {
    const candidates = Object.values(d || {}).filter((v) => typeof v === 'string') as string[];
    const hit = candidates.map(String).find((vs) => known.find((x) => vs.includes(x)));
    if (hit) pantalla = known.find((x) => String(hit).includes(x)) || '';
  }
  const screenMatch = String(pantalla).match(/\d+(?:\.\d+)?/);
  pantalla = screenMatch ? screenMatch[0] : pantalla || '';

  const modelo = d?.modelo ? String(d.modelo).trim() : '';
  const numero = d?.numero != null ? String(d.numero).trim() : '';
  if (tipoP === 'iphone') {
    if (numero && modelo) gama = `${numero} ${modelo}`.trim();
    else if (numero) gama = numero;
    else if (modelo && !gama) gama = modelo;
  } else if (tipoP === 'watch') {
    gama = formatAppleWatchModel(d);
  } else if (tipoP === 'accesorios' && modelo) {
    // La familia queda en detalle.gama; para análisis interesa el modelo exacto.
    gama = modelo;
  } else if (!gama && (tipoP === 'ipad' || tipoP === 'airpods')) {
    if (modelo) gama = modelo;
  }

  const ram = d?.ram ? String(d.ram).trim() : '';
  const ssd =
    (d as any)?.almacenamiento || (d as any)?.ssd
      ? String((d as any)?.almacenamiento || (d as any)?.ssd).trim()
      : '';

  return { tipo: tipoP, gama, proc, pantalla, ram, ssd };
}

function createAttrsMatcher(filters: {
  tipo?: string;
  gama?: string;
  procesador?: string;
  pantalla?: string;
}) {
  const attrsCache = new Map<number, ProductAttrs>();
  const getAttrs = (p: Producto): ProductAttrs => {
    const existing = attrsCache.get(p.id);
    if (existing) return existing;
    const parsed = extractProductAttrs(p);
    attrsCache.set(p.id, parsed);
    return parsed;
  };
  const matchesProductFilters = (p: Producto) => {
    const attrs = getAttrs(p);
    if (filters.tipo && attrs.tipo !== filters.tipo) return false;
    if (filters.gama && attrs.gama !== filters.gama) return false;
    if (filters.procesador && attrs.proc !== filters.procesador) return false;
    if (filters.pantalla && attrs.pantalla !== filters.pantalla) return false;
    return true;
  };
  return { getAttrs, matchesProductFilters };
}

function ym(d: string | Date): string {
  if (typeof d === 'string') {
    const s = d.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 7);
    const parsed = new Date(s);
    if (!isNaN(parsed.getTime())) {
      const y = parsed.getFullYear();
      const m = (parsed.getMonth() + 1).toString().padStart(2, '0');
      return `${y}-${m}`;
    }
    return '';
  }
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  return `${y}-${m}`;
}

const SPLIT_VENDOR = 'ambos';
export const normalizeSeller = (s?: string | null) => {
  const normalized = s == null ? '' : String(s).trim().toLowerCase();
  // Ganancias agrupa etiquetas como "Gonzalo (Jorge)" y
  // "Gonzalo (Williams)" dentro de Gonzalo. Analytics debe aplicar
  // exactamente la misma regla para no excluir esas ventas del periodo.
  if (/^gonzalo\s*\([^)]+\)$/.test(normalized)) return 'gonzalo';
  return normalized;
};
const SELLERS = ['gonzalo', 'renato'];
const getProductoSeller = (producto?: Producto | null) => normalizeSeller((producto as any)?.vendedor as any);
const getVentaSellerHistorico = (venta: Venta) => normalizeSeller((venta as any)?.vendedor as any);
const getVentaSellerProducto = (venta: Venta) => getProductoSeller((venta?.producto as any) || null);
const getVentaSellerBySource = (venta: Venta, source: 'producto' | 'venta') =>
  source === 'producto' ? getVentaSellerProducto(venta) : getVentaSellerHistorico(venta);
const productoShareForSeller = (producto: Producto | null | undefined, seller?: string | null) => {
  const target = normalizeSeller(seller);
  if (!target) return 1;
  if (!producto) return 0;
  const vend = getProductoSeller(producto);
  if (!vend) return 0;
  if (vend === target) return 1;
  if (vend === SPLIT_VENDOR && SELLERS.includes(target)) return 0.5;
  return 0;
};
const matchesProductoSeller = (producto: Producto | null | undefined, seller: string) => {
  return productoShareForSeller(producto, seller) > 0;
};
const shareForSeller = (venta: Venta, seller: string, source: 'producto' | 'venta' = 'venta') => {
  const vend = getVentaSellerBySource(venta, source) || (source === 'venta' ? getProductoSeller(venta.producto) : '');
  if (!seller) return 1;
  if (!vend) return 0;
  if (vend === seller) return 1;
  if (vend === SPLIT_VENDOR) return 0.5;
  return 0;
};

const splitTipoCambio = (venta: Venta, seller: string) => {
  const slug = normalizeSeller(seller);
  const base = Number((venta as any)?.tipoCambio ?? 0);
  if (slug === 'gonzalo') {
    const v = Number((venta as any)?.tipoCambioGonzalo ?? base);
    return v || base || 0;
  }
  if (slug === 'renato') {
    const v = Number((venta as any)?.tipoCambioRenato ?? base);
    return v || base || 0;
  }
  return base || 0;
};

const sellerMetrics = (venta: Venta, seller: string, source: 'producto' | 'venta' = 'venta', historicalCost?: number | null) => {
  const vend = getVentaSellerBySource(venta, source) || (source === 'venta' ? getProductoSeller(venta.producto) : '');
  const target = normalizeSeller(seller);
  if (!vend || !target) return null;

  const precioVentaTotal = Number(venta?.precioVenta ?? 0) || 0;
  const costoTotal = historicalCost ?? (Number(venta?.producto?.valor?.costoTotalProrrateado ?? venta?.producto?.valor?.costoTotal ?? 0) || 0);
  const baseGanancia = precioVentaTotal - costoTotal;

  if (vend === target) {
    const pct = costoTotal > 0 ? (baseGanancia / costoTotal) * 100 : 0;
    return {
      income: precioVentaTotal,
      cost: costoTotal,
      ganancia: baseGanancia,
      porcentaje: pct,
      share: 1,
    };
  }

  if (vend === SPLIT_VENDOR && SELLERS.includes(target)) {
    if (String(venta.producto?.tipo || '').toLowerCase() === 'accesorios') {
      const income = precioVentaTotal / 2;
      const cost = costoTotal / 2;
      const ganancia = income - cost;
      return { income, cost, ganancia, porcentaje: cost > 0 ? ganancia / cost * 100 : 0, share: 0.5 };
    }
    const valorUsd = Number(venta?.producto?.valor?.valorProducto ?? 0) || 0;
    const envioSoles = Number(
      (venta?.producto?.valor as any)?.costoEnvioProrrateado ??
        (venta?.producto?.valor as any)?.costoEnvio ??
        0,
    );
    const tc = splitTipoCambio(venta, target);
    const income = precioVentaTotal / 2;
    const cost = (valorUsd / 2) * tc + (envioSoles / 2);
    const ganancia = income - cost;
    const porcentaje = cost > 0 ? (ganancia / cost) * 100 : 0;
    return {
      income,
      cost,
      ganancia,
      porcentaje,
      share: 0.5,
    };
  }
  return null;
};

const mapVentaForSeller = (venta: Venta, seller: string, source: 'producto' | 'venta' = 'venta', historicalCost?: number | null) => {
  const metrics = sellerMetrics(venta, seller, source, historicalCost);
  if (!metrics) return null;
  const vend = getVentaSellerBySource(venta, source);
  if (vend === normalizeSeller(seller)) return venta;
  return {
    ...venta,
    precioVenta: metrics.income,
    ganancia: metrics.ganancia,
    porcentajeGanancia: metrics.porcentaje,
  } as Venta;
};

// Versión limpia para armar un display legible del producto sin caracteres extraños
function productDisplayClean(p: Producto): string {
  const tipo = (p.tipo || '').toLowerCase();
  const d: any = p.detalle || {};
  if (tipo === 'watch') return formatAppleWatchName(d);

  const sanitize = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // quita acentos
      .replace(/[^a-z0-9_]/g, ''); // quita rarezas/espacios

  // Tamaño de pantalla por claves probables
  let tam: any = null;
  if (d && typeof d === 'object') {
    for (const key of Object.keys(d)) {
      const k = sanitize(key);
      if (
        k.includes('tamano') ||
        k.includes('tamanio') ||
        k.includes('tamanopantalla') ||
        k.includes('pantalla') ||
        k.includes('screen') ||
        k.includes('size') ||
        k === 'tam'
      ) {
        tam = d[key];
        break;
      }
    }
  }
  if (!tam) {
    const candidates = Object.values(d || {}).filter((v) => typeof v === 'string') as string[];
    const known = ['10.2', '10.9', '11', '12.9', '13', '14', '15', '16'];
    for (const val of candidates) {
      const vs = String(val);
      const hit = known.find((x) => vs.includes(x));
      if (hit) { tam = hit; break; }
    }
  }

  // Procesador por alias
  let proc: any = null;
  if (d && typeof d === 'object') {
    for (const key of Object.keys(d)) {
      const k = sanitize(key);
      if (k.includes('procesador') || k === 'cpu' || k.includes('chip') || k.startsWith('proc')) {
        proc = d[key];
        break;
      }
    }
  }

  const ram = (d as any)?.ram || null;
  const alm = (d as any)?.almacenamiento || (d as any)?.ssd || null;
  const con = (d as any)?.conexion || (d as any)?.conectividad || null;
  const modelo = (d as any)?.modelo || null;
  const gama = (d as any)?.gama || null;          // Air/Pro/Normal/etc
  const generacion = (d as any)?.generacion || null; // para Watch u otros

  if (tipo === 'otro') {
    return (d as any).descripcionOtro || 'Otro';
  }

  const fmtTam = (x: any) => {
    if (!x) return null;
    const s = String(x).trim();
    // agrega ": pulgadas" si parece número/decimal
    return /^\d+(?:\.\d+)?$/.test(s) ? `${s}"` : s;
  };

  const parts: string[] = [];
  if (p.tipo) parts.push(String(p.tipo).charAt(0).toUpperCase() + String(p.tipo).slice(1));
  // Gama junto al tipo para MacBook/iPad
  if ((tipo === 'macbook' || tipo === 'ipad') && gama) parts.push(String(gama));
  // Generación junto al tipo para Apple Watch
  if (tipo === 'watch' && generacion) parts.push(String(generacion));

  if (fmtTam(tam)) parts.push(fmtTam(tam)!);
  if (proc) parts.push(String(proc));
  if (ram) parts.push(String(ram));
  if (alm) parts.push(String(alm));
  if (con) parts.push(String(con));
  if (modelo) parts.push(String(modelo));
  return parts.join(' - ');
}

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(Producto) private readonly prodRepo: Repository<Producto>,
    @InjectRepository(ProductoValor) private readonly valorRepo: Repository<ProductoValor>,
    @InjectRepository(ProductoDetalle) private readonly detRepo: Repository<ProductoDetalle>,
    @InjectRepository(Tracking) private readonly trackRepo: Repository<Tracking>,
    @InjectRepository(Venta) private readonly ventaRepo: Repository<Venta>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    @Optional() @InjectRepository(Gasto) private readonly gastoRepo?: Repository<Gasto>,
  ) {}

  private readonly inflight = new Set<string>();
  private readonly sharedInflight = new Map<string, Promise<any>>();
  private readonly fallbackTc = 3.7;

  private buildKey(prefix: string, params: Params): string {
    const entries = Object.entries(params || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `${prefix}:${entries.map(([k, v]) => `${k}=${v}`).join('&')}`;
  }

  private async rememberCached<T>(
    key: string,
    CACHE_TTL_MS: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    key = appCacheKey(this.cache, key);
    const cached = await this.cache.get<T>(key);
    if (cached) return cached;

    const inflight = this.sharedInflight.get(key);
    if (inflight) return inflight as Promise<T>;

    const promise = loader()
      .then(async (value) => {
        await this.cache.set(key, value, CACHE_TTL_MS);
        return value;
      })
      .finally(() => this.sharedInflight.delete(key));

    this.sharedInflight.set(key, promise);
    return promise;
  }

  private async getAnalyticsUniverseCached(): Promise<AnalyticsUniverse> {
    return this.rememberCached('analytics:universe:v3', 45_000, async () => {
      const [productos, ventas] = await Promise.all([
        this.prodRepo.find({
          relations: ['valor', 'detalle', 'tracking'],
          order: { id: 'DESC' },
        }),
        this.ventaRepo
          .createQueryBuilder('v')
          .leftJoinAndSelect('v.producto', 'p')
          .leftJoinAndSelect('p.valor', 'val')
          .leftJoinAndSelect('p.detalle', 'det')
          .orderBy('v.fechaVenta', 'DESC')
          .addOrderBy('v.id', 'DESC')
          .getMany(),
      ]);

      const vendidosHistoricosIds = ventas
        .map((v) => Number(v.productoId))
        .filter((id) => Number.isFinite(id) && id > 0);

      return { productos, ventas, vendidosHistoricosIds };
    });
  }

  // Stale‑while‑revalidate wrapper for the heavy summary aggregation
  async summaryCached(params: Params) {
    const key = appCacheKey(this.cache, this.buildKey('analytics:summary:v6', params));
    const cached: any = await this.cache.get(key);
    const now = Date.now();
    const revalidateMs = 120_000; // recompute in background every 2 min if accessed
    const CACHE_TTL_MS = 600_000; // keep in cache 10 min (served as stale if needed)

    if (cached?.data) {
      const age = now - (cached.cachedAt || 0);
      if (age > revalidateMs && !this.inflight.has(key)) {
        this.inflight.add(key);
        this.summary(params)
          .then((data) => this.cache.set(key, { data, cachedAt: Date.now() }, CACHE_TTL_MS))
          .finally(() => this.inflight.delete(key));
      }
      return cached.data;
    }

    const data = await this.summary(params);
    await this.cache.set(key, { data, cachedAt: now }, CACHE_TTL_MS);
    return data;
  }

  async summary(params: Params) {
    const {
      fromCompra,
      toCompra,
      fromVenta,
      toVenta,
      tipo,
      gama,
      procesador,
      pantalla,
      estadoTracking,
      vendedor,
      transportista,
      casillero,
    } = params;

    const lateDays = params.lateDays ?? 20;
    const aging15 = params.aging15 ?? 15;
    const aging30 = params.aging30 ?? 30;
    const aging60 = params.aging60 ?? 60;
    const marginThreshold = params.marginThreshold ?? 15;

    const dFromCompra = parseDate(fromCompra);
    const dToCompra = parseDate(toCompra);
    const dFromVenta = parseDate(fromVenta);
    const dToVenta = parseDate(toVenta);

    const { getAttrs, matchesProductFilters } = createAttrsMatcher({
      tipo,
      gama,
      procesador,
      pantalla,
    });
    const { productos, ventas: universeVentas, vendidosHistoricosIds } =
      await this.getAnalyticsUniverseCached();
    let ventas = universeVentas.filter((v) => {
      if (!v.fechaVenta) return false;
      const fechaVenta = String(v.fechaVenta).slice(0, 10);
      if (dFromVenta && fechaVenta < String(fromVenta)) return false;
      if (dToVenta && fechaVenta > String(toVenta)) return false;
      return true;
    });

    // Map rápido para acceder al producto completo (incluye tracking)
    const productoById = new Map<number, Producto>();
    for (const p of productos) productoById.set(p.id, p);
    const isAccessory = (p: Producto) => String(p.tipo || '').trim().toLowerCase() === 'accesorios';

    // Filtra ventas por filtros de producto (gama/proc/pantalla/tipo)
    ventas = ventas.filter((v) => {
      const prod = productoById.get(v.productoId) || (v.producto as any as Producto | undefined);
      return prod ? matchesProductFilters(prod) : true;
    });

    // Costo de la venta segun los lotes utilizados, no segun compras del mes.
    for (const v of ventas) {
      const amounts = saleAmounts(v, productoById);
      if (amounts.profit != null) {
        v.ganancia = amounts.profit as any;
        v.porcentajeGanancia = (amounts.markup ?? 0) as any;
      }
    }

    const sellerTarget = normalizeSeller(vendedor);
    if (sellerTarget) {
      ventas = ventas
        .filter((v) => matchesProductoSeller((v.producto as any) || productoById.get(v.productoId), sellerTarget))
        .map((v) => mapVentaForSeller(v, sellerTarget, 'producto', saleCost(v, productoById)))
        .filter(Boolean) as Venta[];
    }

    // Build helper maps
    const ventasByProducto = groupBy(ventas, (v) => v.productoId);
    // Para stock activo, necesitamos saber todos los productos vendidos históricamente
    const vendidosHistoricos = new Set<number>(vendidosHistoricosIds);
    const purchasedUnits = (p: Producto) => isAccessory(p) ? Math.max(0, Number((p as any).stockInicial || 0)) : 1;
    const remainingUnits = (p: Producto) => isAccessory(p)
      ? Math.max(0, Number((p as any).stockActual || 0))
      : (vendidosHistoricos.has(p.id) ? 0 : 1);
    const soldUnits = (v: Venta) => Math.max(1, Number((v as any).cantidad || 1));

    // Filtered products view for inventory calculations
    const productosFiltered = productos.filter((p) => {
      if (isAccessory(p)) return false;
      if (!matchesProductFilters(p)) return false;
      if (sellerTarget && !matchesProductoSeller(p, sellerTarget)) return false;
      if (dFromCompra && (!p.valor || new Date(p.valor.fechaCompra) < dFromCompra)) return false;
      if (dToCompra && (!p.valor || new Date(p.valor.fechaCompra) > dToCompra)) return false;
      if (estadoTracking) {
        const estados = (p.tracking || []).map((t) => t.estado);
        if (!estados.includes(estadoTracking as any)) return false;
      }
      if (transportista || casillero) {
        const ok = (p.tracking || []).some((t) => {
          if (transportista && t.transportista !== transportista) return false;
          if (casillero && t.casillero !== casillero) return false;
          return true;
        });
        if (!ok) return false;
      }
      return true;
    });
    const productosHistoricosComprados = productos.filter((p) => {
      if (isAccessory(p)) return false;
      if (!matchesProductFilters(p)) return false;
      if (sellerTarget && !matchesProductoSeller(p, sellerTarget)) return false;
      if (estadoTracking) {
        const estados = (p.tracking || []).map((t) => t.estado);
        if (!estados.includes(estadoTracking as any)) return false;
      }
      if (transportista || casillero) {
        const ok = (p.tracking || []).some((t) => {
          if (transportista && t.transportista !== transportista) return false;
          if (casillero && t.casillero !== casillero) return false;
          return true;
        });
        if (!ok) return false;
      }
      return true;
    });
    const productoShareById = new Map<number, number>();
    for (const p of productosFiltered) {
      productoShareById.set(p.id, productoShareForSeller(p, sellerTarget));
    }
    const inventoryHistoricalPurchasedUnits = +productosHistoricosComprados
      .reduce((s, p) => s + purchasedUnits(p) * productoShareForSeller(p, sellerTarget), 0)
      .toFixed(2);

    // Helper to build a user-friendly display for each product
    const productDisplay = (p: Producto): string => {
      const tipo = (p.tipo || '').toLowerCase();
      const d: any = p.detalle || {};
      if (tipo === 'watch') return formatAppleWatchName(d);

      const sanitize = (s: string) =>
        s
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '') // quita acentos
          .replace(/[^a-z0-9_]/g, ''); // quita rarezas/�/espacios

      // Busca por clave probable (soporta 'tama��o', 'tamaño', etc.)
      let tam: any = null;
      if (d && typeof d === 'object') {
        for (const key of Object.keys(d)) {
          const k = sanitize(key);
          if (
            k.includes('tamano') ||
            k.includes('tamanio') ||
            k.includes('tamanopantalla') ||
            k.includes('pantalla') ||
            k.includes('screen') ||
            k.includes('size') ||
            k === 'tam'
          ) {
            tam = d[key];
            break;
          }
        }
      }
      // Si no se encontró por clave, intenta detectar tamaño buscando valores típicos en los valores del detalle
      if (!tam) {
        const candidates = Object.values(d || {}).filter((v) => typeof v === 'string') as string[];
        const known = ['10.2', '10.9', '11', '12.9', '13', '14', '15', '16'];
        for (const val of candidates) {
          const vs = String(val);
          const hit = known.find((x) => vs.includes(x));
          if (hit) {
            tam = hit;
            break;
          }
        }
      }

      // Procesador con alias
      let proc: any = null;
      if (d && typeof d === 'object') {
        for (const key of Object.keys(d)) {
          const k = sanitize(key);
          if (k.includes('procesador') || k === 'cpu' || k.includes('chip') || k.startsWith('proc')) {
            proc = d[key];
            break;
          }
        }
      }

      const ram = d?.ram || null;
      const alm = d?.almacenamiento || (d as any)?.ssd || null;
      const con = d?.conexion || (d as any)?.conectividad || null;
      const modelo = d?.modelo || null;
      const gama = d?.gama || null;          // Air/Pro/Normal/etc
      const generacion = d?.generacion || null; // para Watch u otros

      if (tipo === 'otro') {
        return d.descripcionOtro || 'Otro';
      }

      const fmtTam = (x: any) => {
        if (!x) return null;
        const s = String(x).trim();
        // agrega ": pulgadas" si parece puro número/decimal
        return /^\d+(?:\.\d+)?$/.test(s) ? `${s}"` : s;
      };

      const parts: string[] = [];
      if (p.tipo) parts.push(String(p.tipo).charAt(0).toUpperCase() + String(p.tipo).slice(1));
      // Gama junto al tipo para MacBook/iPad
      if ((tipo === 'macbook' || tipo === 'ipad') && gama) parts.push(String(gama));
      // Generación junto al tipo para Apple Watch
      if (tipo === 'watch' && generacion) parts.push(String(generacion));

      if (tipo === 'macbook' || tipo === 'ipad') {
        if (fmtTam(tam)) parts.push(fmtTam(tam)!);
        if (proc) parts.push(String(proc));
      } else {
        if (fmtTam(tam)) parts.push(fmtTam(tam)!);
        if (proc) parts.push(String(proc));
      }

      if (ram) parts.push(String(ram));
      if (alm) parts.push(String(alm));
      if (con) parts.push(String(con));
      if (modelo) parts.push(String(modelo));
      return parts.join(' • ');
    };

    // Active inventory = productos sin venta histórica, pero dentro del filtro de compra (si aplica)
    const latestTrackingEstadoCache = new Map<number, string>();
    const latestTrackingEstado = (p: Producto) => {
      const cached = latestTrackingEstadoCache.get(p.id);
      if (cached !== undefined) return cached;
      const trk = Array.isArray(p.tracking) ? [...p.tracking] : [];
      if (!trk.length) {
        latestTrackingEstadoCache.set(p.id, '');
        return '';
      }
      trk.sort((a, b) => {
        if (a.createdAt && b.createdAt) {
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        }
        return (b.id || 0) - (a.id || 0);
      });
      const estado = String(trk[0]?.estado || '').toLowerCase();
      latestTrackingEstadoCache.set(p.id, estado);
      return estado;
    };

    const productCostParts = (p: Producto) => {
      const valorProductoUsd = Number(p.valor?.valorProducto ?? 0) || 0;
      const baseSoles = Number(p.valor?.valorSoles ?? (valorProductoUsd * 3.7)) || 0;
      const costoTotal = Number(p.valor?.costoTotal ?? 0) || 0;
      const envioInferido = Math.max(0, costoTotal - baseSoles);
      const envioSoles =
        Number((p.valor as any)?.costoEnvioProrrateado ?? p.valor?.costoEnvio ?? envioInferido) || 0;
      return { baseSoles, envioSoles };
    };

    const unsold = productosFiltered.filter((p) => remainingUnits(p) > 0);
    const unsoldValuation = unsold.map((p) => {
      const estadoActual = latestTrackingEstado(p);
      const { baseSoles, envioSoles } = productCostParts(p);
      const ownerShare = productoShareById.get(p.id) ?? 1;
      const initialUnits = Math.max(1, purchasedUnits(p));
      const units = remainingUnits(p);
      const share = units * ownerShare;
      const costFraction = (units / initialUnits) * ownerShare;
      // Solo incluir envio para unidades recogidas (listas para venta).
      const envioIncluido = estadoActual === 'recogido' ? envioSoles * costFraction : 0;
      return {
        p,
        share,
        estadoActual,
        baseSoles: baseSoles * costFraction,
        envioIncluido,
        total: baseSoles * share + envioIncluido,
      };
    });

    const inventoryUnsoldUnits = +unsoldValuation.reduce((s, x) => s + x.share, 0).toFixed(2);
    const inventoryAvailableUnits = +unsoldValuation
      .filter((x) => x.estadoActual === 'recogido')
      .reduce((s, x) => s + x.share, 0)
      .toFixed(2);
    const inventoryActiveUnits = inventoryUnsoldUnits;
    const capitalInmovilizadoProducto = +unsoldValuation
      .reduce((s, x) => s + x.baseSoles, 0)
      .toFixed(2);
    const capitalInmovilizadoEnvio = +unsoldValuation
      .reduce((s, x) => s + x.envioIncluido, 0)
      .toFixed(2);
    const capitalInmovilizado = +(capitalInmovilizadoProducto + capitalInmovilizadoEnvio).toFixed(2);

    // Compras del período (filtradas por fecha de compra)
    const comprasPeriodoUnidades = +productosFiltered
      .reduce((s, p) => s + purchasedUnits(p) * (productoShareById.get(p.id) ?? 1), 0)
      .toFixed(2);
    const comprasPeriodoCapital = +(
      productosFiltered.reduce(
        (s, p) => s + (Number(p.valor?.costoTotal ?? 0) || 0) * (productoShareById.get(p.id) ?? 1),
        0,
      )
    ).toFixed(2);
    // Capital total = suma de todo lo comprado en el universo filtrado (por fecha/tipo que aplique)
    const capitalTotal = comprasPeriodoCapital;
    const comprasPeriodo = productosFiltered.map((p) => ({
      productoId: p.id,
      tipo: p.tipo,
      display: productDisplayClean(p),
      fechaCompra: p.valor?.fechaCompra,
      precioUSD: +(Number(p.valor?.valorProducto ?? 0) * (productoShareById.get(p.id) ?? 1) || 0).toFixed(2),
      costoTotal: +(Number(p.valor?.costoTotal ?? 0) * (productoShareById.get(p.id) ?? 1) || 0).toFixed(2),
      participacion: purchasedUnits(p) * (productoShareById.get(p.id) ?? 1),
    }));

    // SUNAT: gasto del periodo con envio solo para productos recogidos.
    const isRecogido = (estado: string) => estado === 'recogido';
    const sunatRows = productosFiltered.map((p) => {
      const estadoActual = latestTrackingEstado(p);
      const { baseSoles, envioSoles } = productCostParts(p);
      const share = productoShareById.get(p.id) ?? 1;
      const envioIncluido = isRecogido(estadoActual) ? envioSoles * share : 0;
      return {
        baseSoles: baseSoles * share,
        envioIncluido,
        valorDec: (Number(p.valor?.valorDec ?? 0) || 0) * share,
      };
    });
    const sunatGastoProductos = +sunatRows.reduce((s, x) => s + x.baseSoles, 0).toFixed(2);
    const sunatGastoEnvio = +sunatRows.reduce((s, x) => s + x.envioIncluido, 0).toFixed(2);
    const sunatGastoTotal = +(sunatGastoProductos + sunatGastoEnvio).toFixed(2);
    const sunatValorDecTotal = +sunatRows.reduce((s, x) => s + x.valorDec, 0).toFixed(2);
    const sunatTotalVendidoPeriodo = +ventas.reduce(
      (s, v) => s + (Number(v.precioVenta) || 0),
      0,
    ).toFixed(2);
    const sunatGananciaTotal = +(ventas.reduce((s, v) => s + (Number(v.ganancia) || 0), 0)).toFixed(2);

    // No vendidos del período (comprados en el período y aún sin vender)
    const nowForNoVendidos = new Date();
    const noVendidosDelPeriodo = productosFiltered
      .filter((p) => remainingUnits(p) > 0)
      .map((p) => {
        const recogidos = (p.tracking || [])
          .map((t) => t.fechaRecogido)
          .filter((x): x is string => !!x)
          .sort();
        const frg = recogidos.length ? recogidos[recogidos.length - 1] : undefined;
        const dias = daysBetween(frg || null, nowForNoVendidos);
        return {
          productoId: p.id,
          tipo: p.tipo,
          display: productDisplayClean(p),
          costoTotal: +(Number(p.valor?.costoTotal ?? 0) * (remainingUnits(p) / Math.max(1, purchasedUnits(p))) * (productoShareById.get(p.id) ?? 1) || 0).toFixed(2),
          participacion: remainingUnits(p) * (productoShareById.get(p.id) ?? 1),
          fechaCompra: p.valor?.fechaCompra,
          fechaRecogido: frg || null,
          diasDesdeRecogido: dias,
        };
      });

    // Inventory by type for current unsold
    const byTypeMap = new Map<string, { unidades: number; activos: number; capital: number }>();
    for (const row of unsoldValuation) {
      const p = row.p;
      const k = p.tipo || 'otro';
      const curr = byTypeMap.get(k) || { unidades: 0, activos: 0, capital: 0 };
      curr.unidades += row.share;
      if (row.estadoActual === 'recogido') curr.activos += row.share;
      curr.capital += row.total;
      byTypeMap.set(k, curr);
    }
    const inventoryByType = Array.from(byTypeMap.entries()).map(([tipo, v]) => ({
      tipo,
      unidades: v.unidades,
      activos: v.activos,
      capital: +v.capital.toFixed(2),
    }));

    // Aging buckets for unsold
    const today = new Date();
    const aging: any = { bucket15_29: [], bucket30_59: [], bucket60_plus: [] };
    function pushAging(p: Producto, dias: number) {
      const item = {
        productoId: p.id,
        tipo: p.tipo,
        display: productDisplayClean(p),
        estado: p.estado,
        fechaCompra: p.valor?.fechaCompra,
        costoTotal: p.valor?.costoTotal ?? null,
        diasEnStock: dias,
      };
      if (dias >= aging60) aging.bucket60_plus.push(item);
      else if (dias >= aging30) aging.bucket30_59.push(item);
      else if (dias >= aging15) aging.bucket15_29.push(item);
    }
    for (const p of unsold) {
      // Antigüedad debe calcularse desde fecha de recogido (cuando el producto ya está en stock).
      // Usamos la última fechaRecogido disponible en tracking; si no existe, no se considera para antigüedad.
      const recogidos = (p.tracking || [])
        .map((t) => t.fechaRecogido)
        .filter((x): x is string => !!x)
        .sort();
      const fr = recogidos.length ? recogidos[recogidos.length - 1] : undefined;
      const d = daysBetween(fr || null, today);
      if (d != null) pushAging(p, d);
    }

    // Rotation median days (purchase -> sale) for sold items
    const rotationDays: number[] = [];
    for (const v of ventas) {
      const fp = v.producto?.valor?.fechaCompra;
      const d = daysBetween(fp || null, v.fechaVenta);
      if (d != null) rotationDays.push(d);
    }
    const rotationMedianDaysOverall = median(rotationDays) ?? null;

    // Monthly metrics (ingresos, ganancia, margen % promedio)
    const ventasByMonth = groupBy(ventas, (v) => ym(v.fechaVenta));
    const monthlies = Array.from(ventasByMonth.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([month, arr]) => {
        const ingresos = +(arr.reduce((s, x) => s + Number(x.precioVenta), 0)).toFixed(2);
        const ganancia = +(arr.reduce((s, x) => s + Number(x.ganancia), 0)).toFixed(2);
        const margenPromedio = mean(arr.map((x) => Number(x.porcentajeGanancia))) ?? 0;
        return { month, ventas: arr.length, ingresos, ganancia, margenPromedio: +(margenPromedio?.toFixed(3) || 0) };
      });

    // Logistics: compra -> recepción (per product), recepción -> recogido (per product), recogido -> venta (per sale)
    const compraToRecepDays: number[] = [];
    const compraToRecogDays: number[] = [];
    const recepToRecogDays: number[] = [];
    const recogToVentaDays: number[] = [];
    const compraToVentaDays: number[] = [];
    const recepToVentaDays: number[] = [];

    // Acumuladores por tipo
    const byType_compraToRecep = new Map<string, number[]>();
    const byType_compraToRecog = new Map<string, number[]>();
    const byType_recepToRecog = new Map<string, number[]>();
    const byType_recogToVenta = new Map<string, number[]>();
    const byType_compraToVenta = new Map<string, number[]>();
    const transportistasAgg = new Map<string, { total: number; tardias: number; dias: number[] }>();
    const casillerosAgg = new Map<string, { dias: number[]; total: number; tardias: number }>();

    for (const p of productosFiltered) {
      const fp = p.valor?.fechaCompra;
      // pick a relevant reception date (max available)
      const recepDates = (p.tracking || [])
        .map((t) => t.fechaRecepcion)
        .filter((x): x is string => !!x)
        .sort();
      const fr = recepDates.length ? recepDates[recepDates.length - 1] : undefined;

      const dcr = daysBetween(fp || null, fr || null);
      if (dcr != null) {
        compraToRecepDays.push(dcr);
        const tipoP = p.tipo || 'otro';
        const arr = byType_compraToRecep.get(tipoP) || [];
        arr.push(dcr);
        byType_compraToRecep.set(tipoP, arr);
      }

      // by transportista and casillero using the latest record that has values
      const latestWithMeta = (p.tracking || [])
        .filter((t) => t.transportista || t.casillero || t.fechaRecepcion)
        .sort((a, b) => (a.id || 0) - (b.id || 0))
        .slice(-1)[0];
      if (latestWithMeta?.transportista && dcr != null) {
        const k = latestWithMeta.transportista;
        const curr = transportistasAgg.get(k) || { total: 0, tardias: 0, dias: [] };
        curr.total += 1;
        if (dcr > lateDays) curr.tardias += 1;
        curr.dias.push(dcr);
        transportistasAgg.set(k, curr);
      }
      if (latestWithMeta?.casillero && dcr != null) {
        const k = latestWithMeta.casillero;
        const curr = casillerosAgg.get(k) || { dias: [], total: 0, tardias: 0 };
        curr.total += 1;
        if (dcr > lateDays) curr.tardias += 1;
        curr.dias.push(dcr);
        casillerosAgg.set(k, curr);
      }
      // recepcion -> recogido por producto (usar últimas fechas disponibles)
      const recogidos = (p.tracking || [])
        .map((t) => t.fechaRecogido)
        .filter((x): x is string => !!x)
        .sort();
      const frg = recogidos.length ? recogidos[recogidos.length - 1] : undefined;
      // compra -> recogido por producto
      const dcrg = daysBetween(fp || null, frg || null);
      if (dcrg != null) {
        compraToRecogDays.push(dcrg);
        const tipoP = p.tipo || 'otro';
        const arr = byType_compraToRecog.get(tipoP) || [];
        arr.push(dcrg);
        byType_compraToRecog.set(tipoP, arr);
      }
      const drr = daysBetween(fr || null, frg || null);
      if (drr != null) {
        recepToRecogDays.push(drr);
        const tipoP = p.tipo || 'otro';
        const arr = byType_recepToRecog.get(tipoP) || [];
        arr.push(drr);
        byType_recepToRecog.set(tipoP, arr);
      }
    }
    for (const v of ventas) {
      // recogido -> venta por venta (usar última fechaRecogido del producto completo con tracking)
      const pFull = productoById.get(v.productoId);
      const recogidos = (pFull?.tracking as any[] | undefined)?.map((t) => t.fechaRecogido).filter(Boolean) || [];
      const frg = recogidos.length ? [...recogidos].sort()[recogidos.length - 1] : undefined;
      const drv = daysBetween(frg || null, v.fechaVenta);
      if (drv != null) {
        recogToVentaDays.push(drv);
        const tipoV = v.producto?.tipo || 'otro';
        const arr = byType_recogToVenta.get(tipoV) || [];
        arr.push(drv);
        byType_recogToVenta.set(tipoV, arr);
      }

      // compra -> venta por venta (si no viene en la venta, cae al producto completo)
      const fpv = v.producto?.valor?.fechaCompra || pFull?.valor?.fechaCompra;
      const dcv = daysBetween(fpv || null, v.fechaVenta);
      if (dcv != null) {
        compraToVentaDays.push(dcv);
        const tipoV = v.producto?.tipo || 'otro';
        const arr2 = byType_compraToVenta.get(tipoV) || [];
        arr2.push(dcv);
        byType_compraToVenta.set(tipoV, arr2);
      }

      // recepción -> venta por venta (compatibilidad con frontend actual) usando producto completo
      const recepDates = (pFull?.tracking as any[] | undefined)?.map((t) => t.fechaRecepcion).filter(Boolean) || [];
      const fr = recepDates.length ? [...recepDates].sort()[recepDates.length - 1] : undefined;
      const drv2 = daysBetween(fr || null, v.fechaVenta);
      if (drv2 != null) recepToVentaDays.push(drv2);
    }

    // Construcción de métricas por tipo
    const tiposSet = new Set<string>([
      ...Array.from(byType_compraToRecep.keys()),
      ...Array.from(byType_compraToRecog.keys()),
      ...Array.from(byType_recepToRecog.keys()),
      ...Array.from(byType_recogToVenta.keys()),
      ...Array.from(byType_compraToVenta.keys()),
    ]);
    const porTipo = Array.from(tiposSet.values()).map((tipo) => ({
      tipo,
      compraARecepcion: { mean: mean(byType_compraToRecep.get(tipo) || []), median: median(byType_compraToRecep.get(tipo) || []) },
      compraARecogido: { mean: mean(byType_compraToRecog.get(tipo) || []), median: median(byType_compraToRecog.get(tipo) || []) },
      recepcionARecogido: { mean: mean(byType_recepToRecog.get(tipo) || []), median: median(byType_recepToRecog.get(tipo) || []) },
      recogidoAVenta: { mean: mean(byType_recogToVenta.get(tipo) || []), median: median(byType_recogToVenta.get(tipo) || []) },
      compraAVenta: { mean: mean(byType_compraToVenta.get(tipo) || []), median: median(byType_compraToVenta.get(tipo) || []) },
    }));

    const logistica = {
      compraARecepcion: { mean: mean(compraToRecepDays), median: median(compraToRecepDays) },
      compraARecogido: { mean: mean(compraToRecogDays), median: median(compraToRecogDays) },
      recepcionARecogido: { mean: mean(recepToRecogDays), median: median(recepToRecogDays) },
      recogidoAVenta: { mean: mean(recogToVentaDays), median: median(recogToVentaDays) },
      compraAVenta: { mean: mean(compraToVentaDays), median: median(compraToVentaDays) },
      recepcionAVenta: { mean: mean(recepToVentaDays), median: median(recepToVentaDays) },
      porTipo,
      tardiasPorTransportista: Array.from(transportistasAgg.entries()).map(([k, v]) => ({
        transportista: k,
        total: v.total,
        tardias: v.tardias,
        rate: v.total ? +(v.tardias / v.total * 100).toFixed(2) : 0,
        meanDays: mean(v.dias),
        medianDays: median(v.dias),
      })),
      desempenoPorCasillero: Array.from(casillerosAgg.entries()).map(([k, v]) => ({
        casillero: k,
        total: v.total,
        tardias: v.tardias,
        rate: v.total ? +(v.tardias / v.total * 100).toFixed(2) : 0,
        meanDays: mean(v.dias),
        medianDays: median(v.dias),
      })),
    };

    // Margin by type/model
    const ventasByTipo = groupBy(ventas, (v) => v.producto?.tipo || 'otro');
    const marginByType = Array.from(ventasByTipo.entries()).map(([tipo, arr]) => ({
      tipo,
      margenPromedio: mean(arr.map((x) => Number(x.porcentajeGanancia))) ?? 0,
    }));
    // Detalle por tipo: vendidos (en el período filtrado) y stock actual (sin ventas históricas)
    // Ventas en período (ya filtradas por from/to venta)
    const vendidosPeriodoByTipo = new Map<string, { productoId: number; display: string; cantidad: number; fechaVenta?: string | null; precioVenta?: number | null; margen?: number | null }[]>();
    for (const v of ventas) {
      const t = v.producto?.tipo || 'otro';
      const arr = vendidosPeriodoByTipo.get(t) || [];
      if (v.producto) {
        arr.push({
          productoId: v.productoId,
          display: productDisplayClean(v.producto as any),
          cantidad: soldUnits(v),
          fechaVenta: v.fechaVenta,
          precioVenta: Number(v.precioVenta),
          margen: Number(v.porcentajeGanancia),
        });
      }
      vendidosPeriodoByTipo.set(t, arr);
    }
    // Stock actual independiente del filtro de ventas (productos sin ninguna venta histórica)
    const stockActual = productos.filter(
      (p) =>
        !isAccessory(p) &&
        remainingUnits(p) > 0 &&
        matchesProductFilters(p) &&
        (!sellerTarget || matchesProductoSeller(p, sellerTarget)),
    );
    const stockByTipo = new Map<string, { productoId: number; display: string; cantidad: number }[]>();
    for (const p of stockActual) {
      if (tipo && p.tipo !== tipo) continue;
      const t = p.tipo || 'otro';
      const arr = stockByTipo.get(t) || [];
      arr.push({ productoId: p.id, display: productDisplayClean(p), cantidad: remainingUnits(p) });
      stockByTipo.set(t, arr);
    }
    const tiposUnion = new Set<string>([
      ...Array.from(ventasByTipo.keys()),
      ...Array.from(stockByTipo.keys()),
    ]);
    const porTipoDetalle = Array.from(tiposUnion.values()).map((t) => {
      const ven = vendidosPeriodoByTipo.get(t) || [];
      const stk = stockByTipo.get(t) || [];
      return {
        tipo: t,
        vendidos: { total: ven.reduce((sum, item) => sum + item.cantidad, 0), items: ven },
        stock: { total: stk.reduce((sum, item) => sum + item.cantidad, 0), items: stk },
      };
    });
    const comprasByTipo = groupBy(productosFiltered, (p) => p.tipo || 'otro');
    const totalProductosFiltrados = productosFiltered.reduce(
      (sum, p) => sum + purchasedUnits(p) * (productoShareById.get(p.id) ?? 1),
      0,
    );
    const financialByType = Array.from(
      new Set<string>([
        ...Array.from(comprasByTipo.keys()),
        ...Array.from(ventasByTipo.keys()),
      ]),
    )
      .map((tipoKey) => {
        const comprasTipo = comprasByTipo.get(tipoKey) || [];
        const ventasTipo = ventasByTipo.get(tipoKey) || [];
        const unidadesCompradas = comprasTipo.reduce(
          (sum, p) => sum + purchasedUnits(p) * (productoShareById.get(p.id) ?? 1),
          0,
        );
        const unidadesVendidas = ventasTipo.reduce((sum, v) => sum + soldUnits(v), 0);
        const compradoTotal = comprasTipo.reduce(
          (s, p) => s + ((Number(p.valor?.costoTotal ?? 0) || 0) * (productoShareById.get(p.id) ?? 1)),
          0,
        );
        const vendidoTotal = ventasTipo.reduce((s, v) => s + (Number(v.precioVenta) || 0), 0);
        const gananciaTotal = ventasTipo.reduce((s, v) => s + (Number(v.ganancia) || 0), 0);
        const margenPromedio = mean(ventasTipo.map((v) => Number(v.porcentajeGanancia) || 0)) ?? 0;
        const rotacionMedia = mean(byType_compraToVenta.get(tipoKey) || []);
        return {
          tipo: tipoKey,
          unidadesCompradas,
          unidadesVendidas,
          porcentajeSobreTotalProductos: totalProductosFiltrados
            ? +((unidadesVendidas / totalProductosFiltrados) * 100).toFixed(2)
            : 0,
          compradoTotal: +compradoTotal.toFixed(2),
          vendidoTotal: +vendidoTotal.toFixed(2),
          gananciaTotal: +gananciaTotal.toFixed(2),
          margenPromedio: +(margenPromedio?.toFixed(2) || 0),
          rotacionMedia: rotacionMedia != null ? +rotacionMedia.toFixed(1) : null,
        };
      })
      .sort((a, b) =>
        (b.unidadesVendidas - a.unidadesVendidas) ||
        (b.gananciaTotal - a.gananciaTotal) ||
        (b.compradoTotal - a.compradoTotal),
      );
    // Eliminado: margen % por modelo (solicitado)

    // Top/bottom ventas by ganancia
    const sortedByGan = [...ventas].sort((a, b) => Number(b.ganancia) - Number(a.ganancia));
    const topVentas = sortedByGan.slice(0, 10).map((v) => ({
      id: v.id,
      productoId: v.productoId,
      tipo: v.producto?.tipo,
      modelo: v.producto?.detalle?.modelo,
      display: v.producto ? productDisplayClean(v.producto as any) : undefined,
      fechaVenta: v.fechaVenta,
      precioVenta: Number(v.precioVenta),
      ganancia: Number(v.ganancia),
      margen: Number(v.porcentajeGanancia),
    }));
    const bottomVentas = sortedByGan.slice(-10).map((v) => ({
      id: v.id,
      productoId: v.productoId,
      tipo: v.producto?.tipo,
      modelo: v.producto?.detalle?.modelo,
      display: v.producto ? productDisplayClean(v.producto as any) : undefined,
      fechaVenta: v.fechaVenta,
      precioVenta: Number(v.precioVenta),
      ganancia: Number(v.ganancia),
      margen: Number(v.porcentajeGanancia),
    }));

    // Days to sale by type (percentiles approximated by quartiles)
    const daysByType = new Map<string, number[]>();
    for (const v of ventas) {
      const t = v.producto?.tipo || 'otro';
      const fp = v.producto?.valor?.fechaCompra;
      const d = daysBetween(fp || null, v.fechaVenta);
      if (d != null) {
        const arr = daysByType.get(t) || [];
        arr.push(d);
        daysByType.set(t, arr);
      }
    }
    function quartiles(arr: number[]) {
      if (!arr.length) return { p25: null, p50: null, p75: null };
      const s = [...arr].sort((a, b) => a - b);
      const q = (p: number) => {
        const pos = (s.length - 1) * p;
        const base = Math.floor(pos);
        const rest = pos - base;
        if (s[base + 1] !== undefined) return s[base] + rest * (s[base + 1] - s[base]);
        return s[base];
      };
      return { p25: +q(0.25).toFixed(2), p50: +q(0.5).toFixed(2), p75: +q(0.75).toFixed(2) };
    }
    const diasHastaVentaPorTipo = Array.from(daysByType.entries()).map(([k, arr]) => ({ tipo: k, ...quartiles(arr) }));

    // Product groups (MacBook): aggregate stats by gama/proc/pantalla from productos + ventas
    type GroupKey = string;
    type CompraDetalle = { productoId: number; fechaCompra?: string | Date | null; precioUSD?: number | null; costoTotal?: number | null; estado?: string | null; ram?: string | null; ssd?: string | null; accesoriosCategoria?: string; };
    type VentaDetalle = { ventaId: number; productoId: number; fechaVenta?: string | Date | null; precioVenta?: number | null; ganancia?: number | null; porcentaje?: number | null; dias?: number | null; estado?: string | null; accesoriosCategoria?: string; };
    type Group = {
      tipo: string;
      gama: string;
      proc: string;
      pantalla: string;
      estado: string;
      ram: string;
      ssd: string;
      compras: number[];
      ventas: number[];
      margenes: number[];
      comprasDet: CompraDetalle[];
      ventasDet: VentaDetalle[];
      ramSet: Set<string>;
      ssdSet: Set<string>;
    };
    const groups = new Map<GroupKey, Group>();
    const normalizeProductState = (value: unknown) => {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized === 'new') return 'nuevo';
      if (normalized === 'used') return 'usado';
      return normalized;
    };
    const accessoryCategory = (value: unknown) => {
      const items = Array.isArray(value)
        ? value.map((item) => String(item || '').trim().toLowerCase()).filter((item) => item && item !== 'ninguno')
        : [];
      if (items.includes('caja')) return 'caja';
      if (items.length) return 'accesorios';
      return 'sin_nada';
    };
    for (const p of productosFiltered) {
      const a = getAttrs(p);
      const estado = normalizeProductState(p.estado) || 'sin estado';
      const ram = a.ram || '';
      const ssd = a.ssd || '';
      const k: GroupKey = [a.tipo || 'otro', a.gama || '-', a.proc || '-', a.pantalla || '-', estado, ram || '-', ssd || '-'].join('|');
      const g: Group = groups.get(k) || { tipo: a.tipo || 'otro', gama: a.gama || '', proc: a.proc || '', pantalla: a.pantalla || '', estado, ram, ssd, compras: [], ventas: [], margenes: [], comprasDet: [], ventasDet: [], ramSet: new Set(), ssdSet: new Set() };
      const compraUnits = Math.max(1, purchasedUnits(p));
      const compraUnitCost = (Number(p.valor?.costoTotal ?? 0) || 0) / compraUnits;
      const compraUnitUsd = (Number(p.valor?.valorProducto ?? 0) || 0) / compraUnits;
      for (let unit = 0; unit < compraUnits; unit += 1) g.compras.push(compraUnitCost);
      g.comprasDet.push({
        productoId: p.id,
        fechaCompra: p.valor?.fechaCompra || null,
        precioUSD: compraUnitUsd || null,
        costoTotal: compraUnitCost || null,
        estado: p.estado || null,
        ram: a.ram || null,
        ssd: a.ssd || null,
        accesoriosCategoria: accessoryCategory(p.accesorios),
      });
      if (a.ram) g.ramSet.add(a.ram);
      if (a.ssd) g.ssdSet.add(a.ssd);
      groups.set(k, g);
    }
    for (const v of ventas) {
      const productoLite = v.producto as any as Producto;
      const productoFull = productoById.get(v.productoId) || productoLite;
      const p = productoLite || productoFull;
      if (!p) continue;
      const a = getAttrs(p);
      const estado = normalizeProductState(p.estado) || 'sin estado';
      const ram = a.ram || '';
      const ssd = a.ssd || '';
      const k: GroupKey = [a.tipo || 'otro', a.gama || '-', a.proc || '-', a.pantalla || '-', estado, ram || '-', ssd || '-'].join('|');
      const g: Group = groups.get(k) || { tipo: a.tipo || 'otro', gama: a.gama || '', proc: a.proc || '', pantalla: a.pantalla || '', estado, ram, ssd, compras: [], ventas: [], margenes: [], comprasDet: [], ventasDet: [], ramSet: new Set(), ssdSet: new Set() };
      const ventaUnits = soldUnits(v);
      const ventaUnitPrice = (Number(v.precioVenta) || 0) / ventaUnits;
      const ventaUnitGain = (Number(v.ganancia) || 0) / ventaUnits;
      for (let unit = 0; unit < ventaUnits; unit += 1) {
        g.ventas.push(ventaUnitPrice);
        g.margenes.push(Number(v.porcentajeGanancia) || 0);
      }
      const tracking = productoFull?.tracking || [];
      const fechasRecogido = tracking
        .map((t) => t?.fechaRecogido)
        .filter((d): d is string => !!d)
        .sort();
      const fechaRecogido = fechasRecogido.length ? fechasRecogido[fechasRecogido.length - 1] : null;
      g.ventasDet.push({
        ventaId: v.id,
        productoId: v.productoId,
        fechaVenta: v.fechaVenta,
        precioVenta: ventaUnitPrice || null,
        ganancia: ventaUnitGain || null,
        porcentaje: Number(v.porcentajeGanancia) || null,
        dias: fechaRecogido ? daysBetween(fechaRecogido, v.fechaVenta) : null,
        estado: p.estado || null,
        accesoriosCategoria: accessoryCategory(productoFull?.accesorios ?? p.accesorios),
      });
      if (a.ram) g.ramSet.add(a.ram);
      if (a.ssd) g.ssdSet.add(a.ssd);
      groups.set(k, g);
    }
    function statsLocal(arr: number[]) {
      const clean = (arr || []).filter((n)=> isFinite(n) && n>0);
      if (!clean.length) return { count: 0, min: null, mean: null, p25: null, p50: null, p75: null } as any;
      const s = [...clean].sort((a,b)=> a-b);
      const q = (p:number) => { const pos=(s.length-1)*p; const base=Math.floor(pos); const rest=pos-base; return s[base+1]!==undefined ? s[base]+rest*(s[base+1]-s[base]) : s[base]; };
      return { count: clean.length, min: +s[0].toFixed(2), mean: +mean(clean)!, p25: +q(0.25).toFixed(2), p50: +q(0.5).toFixed(2), p75: +q(0.75).toFixed(2) };
    }
    const productGroups = Array.from(groups.values()).map((g)=>{
      const comprasStats = statsLocal(g.compras);
      const ventasStats = statsLocal(g.ventas);
      const margenPromedio = mean(g.margenes) ?? null;
      const recMin = ventasStats.p25 != null ? +(Number(ventasStats.p25)/1.2).toFixed(2) : null;
      const recMax = ventasStats.p75 != null ? +(Number(ventasStats.p75)/1.2).toFixed(2) : null;
      const tipoKey = (g.tipo || '').toLowerCase();
      const labelParts: string[] = [];
      if (tipoKey === 'macbook') {
        labelParts.push('MacBook');
        if (g.gama) labelParts.push(g.gama);
        if (g.pantalla) labelParts.push(`${g.pantalla}\"`);
        if (g.proc) labelParts.push(g.proc);
      } else if (tipoKey === 'iphone') {
        labelParts.push('iPhone');
        if (g.gama) labelParts.push(g.gama);
      } else if (tipoKey === 'ipad') {
        labelParts.push('iPad');
        if (g.gama) labelParts.push(g.gama);
        if (g.pantalla) labelParts.push(`${g.pantalla}\"`);
        if (g.proc) labelParts.push(g.proc);
      } else if (tipoKey === 'watch') {
        labelParts.push('Apple Watch');
        if (g.gama) labelParts.push(g.gama);
      } else if (tipoKey === 'macmini') {
        labelParts.push('Mac mini');
        if (g.proc) labelParts.push(g.proc);
      } else if (tipoKey === 'imac') {
        labelParts.push('iMac');
        if (g.pantalla) labelParts.push(`${g.pantalla}\"`);
        if (g.proc) labelParts.push(g.proc);
      } else if (tipoKey === 'airpods') {
        labelParts.push(g.gama || 'AirPods');
      } else if (tipoKey === 'accesorios') {
        labelParts.push('Accesorios');
        if (g.gama) labelParts.push(g.gama);
      } else {
        labelParts.push(g.tipo || 'Producto');
        if (g.gama) labelParts.push(g.gama);
        if (g.pantalla) labelParts.push(`${g.pantalla}\"`);
        if (g.proc) labelParts.push(g.proc);
      }
      return {
        tipo: g.tipo,
        gama: g.gama,
        proc: g.proc,
        pantalla: g.pantalla,
        estado: g.estado,
        ram: g.ram,
        ssd: g.ssd,
        label: labelParts.join(' '),
        compras: comprasStats,
        ventas: { ...ventasStats, margenPromedio },
        recomendaciones: { compraMaxPara20: { min: recMin, max: recMax } },
        ramDistinct: Array.from(g.ramSet.values()),
        ssdDistinct: Array.from(g.ssdSet.values()),
        // Listas crudas para UI
        comprasList: g.compras,
        ventasList: g.ventas,
        margenesList: g.margenes,
        comprasDetalle: g.comprasDet.slice().sort((a, b) => (Number(a.costoTotal || 0) - Number(b.costoTotal || 0))),
        ventasDetalle: g.ventasDet.slice().sort((a, b) => (Number(a.precioVenta || 0) - Number(b.precioVenta || 0))),
      };
    }).sort((a,b)=> (b.ventas.count||0) - (a.ventas.count||0));

    // Alerts
    const lowMarginVentas = ventas
      .filter((v) => Number(v.porcentajeGanancia) < marginThreshold)
      .map((v) => ({
        id: v.id,
        productoId: v.productoId,
        tipo: v.producto?.tipo,
        modelo: v.producto?.detalle?.modelo,
        display: v.producto ? productDisplayClean(v.producto as any) : undefined,
        fechaVenta: v.fechaVenta,
        ganancia: Number(v.ganancia),
        margen: Number(v.porcentajeGanancia),
      }));

    const transitLongItems: any[] = [];
    for (const p of productosFiltered) {
      const estados = (p.tracking || []).map((t) => t.estado);
      // pick a latest tracking entry for meta
      const latest = (p.tracking || []).slice().sort((a, b) => (a.id || 0) - (b.id || 0)).pop();
      const estado = latest?.estado;
      if (!estado || (ventasByProducto.get(p.id)?.length)) continue; // ignore sold

      if (estado === 'comprado_en_camino') {
        const d = daysBetween(p.valor?.fechaCompra || null, new Date());
        if (d != null && d > lateDays) {
          transitLongItems.push({ productoId: p.id, tipo: p.tipo, display: productDisplayClean(p), estado, dias: d, transportista: latest?.transportista, casillero: latest?.casillero });
        }
      }
      if (estado === 'en_eshopex') {
        const d = daysBetween(latest?.fechaRecepcion || null, new Date());
        if (d != null && d > lateDays) {
          transitLongItems.push({ productoId: p.id, tipo: p.tipo, display: productDisplayClean(p), estado, dias: d, transportista: latest?.transportista, casillero: latest?.casillero });
        }
      }
    }

    return {
      filtersEchoed: {
        fromCompra,
        toCompra,
        fromVenta,
        toVenta,
        tipo,
        gama,
        procesador,
        pantalla,
        estadoTracking,
        vendedor,
        transportista,
        casillero,
        lateDays,
        aging15,
        aging30,
        aging60,
        marginThreshold,
      },
      summary: {
        inventoryActiveUnits,
        inventoryUnsoldUnits,
        inventoryAvailableUnits,
        inventoryHistoricalPurchasedUnits,
        capitalInmovilizado,
        capitalInmovilizadoProducto,
        capitalInmovilizadoEnvio,
        capitalTotal,
        comprasPeriodoUnidades,
        comprasPeriodoCapital,
        rotationMedianDaysOverall,
        monthlies,
        sunat: {
          gastoPeriodo: sunatGastoProductos,
          enviosRecogidos: sunatGastoEnvio,
          valorDecPeriodoTotal: sunatValorDecTotal,
          totalVendidoPeriodo: sunatTotalVendidoPeriodo,
          gastoTotal: sunatGastoTotal,
          gastoProductos: sunatGastoProductos,
          gastoEnvio: sunatGastoEnvio,
          gananciaTotal: sunatGananciaTotal,
          valorDecTotal: sunatValorDecTotal,
        },
      },
      comprasPeriodo,
      inventoryByType,
      aging,
      logistica,
      noVendidosDelPeriodo,
      sales: {
        perMonth: monthlies,
        marginByType,
        financialByType,
        porTipoDetalle,
        topVentas,
        bottomVentas,
        diasHastaVentaPorTipo,
      },
      alerts: {
        lowMarginVentas,
        transitLongItems,
      },
      productGroups,
    };
  }

  async financialDashboard(params: FinancialParams) {
    const { productos, ventas } = await this.getAnalyticsUniverseCached();
    const productsById = new Map(productos.map((product) => [product.id, product]));
    const { matchesProductFilters, getAttrs } = createAttrsMatcher(params);
    const seller = normalizeSeller(params.vendedor);
    const from = params.from || '0001-01-01';
    const to = params.to || '9999-12-31';
    const group = params.groupBy || 'month';
    const periodOf = (date: string) => group === 'day' ? date.slice(0, 10) : group === 'year' ? date.slice(0, 4) : date.slice(0, 7);
    const dateKey = (value: unknown): string => {
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
      const text = String(value || '');
      return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
    };
    const inRange = (date: unknown) => {
      const key = dateKey(date);
      return !!key && key >= from && key <= to;
    };
    const selected = (product: Producto) => matchesProductFilters(product)
      && (!params.estado || String(product.estado || '').toLowerCase() === params.estado.toLowerCase())
      && (!params.ram || getAttrs(product).ram.toLowerCase() === params.ram.toLowerCase())
      && (!params.ssd || getAttrs(product).ssd.toLowerCase() === params.ssd.toLowerCase())
      && (!params.estadoTracking || (product.tracking || []).some((row) => row.estado === params.estadoTracking));
    const selectedProducts = productos.filter(selected);
    const selectedIds = new Set(selectedProducts.map((product) => product.id));
    const filteredSales = ventas.filter((sale) => selectedIds.has(sale.productoId) && inRange(sale.fechaVenta));
    const saleRows = filteredSales.map((sale) => {
      const product = productsById.get(sale.productoId)!;
      const totalCost = saleCost(sale, productsById);
      const sellerPart = seller ? sellerMetrics(sale, seller, 'venta', totalCost) : null;
      if (seller && !sellerPart) return null;
      const income = roundMoney(sellerPart ? sellerPart.income : Number(sale.precioVenta || 0));
      const cost = totalCost == null ? null : roundMoney(sellerPart ? sellerPart.cost : totalCost);
      return {
        id: sale.id,
        productoId: product.id,
        category: String(product.tipo || 'otro').toLowerCase(),
        name: productDisplayClean(product),
        model: [getAttrs(product).tipo, getAttrs(product).gama, getAttrs(product).proc, getAttrs(product).pantalla, getAttrs(product).ram, getAttrs(product).ssd, product.estado].filter(Boolean).join(' · '),
        state: product.estado || 'Sin estado',
        date: String(sale.fechaVenta).slice(0, 10),
        purchaseDate: dateKey(product.valor?.fechaCompra),
        units: Number(sale.cantidad || 1) * (sellerPart?.share ?? 1),
        income,
        cost,
        profit: cost == null ? null : roundMoney(income - cost),
        days: daysBetween(product.valor?.fechaCompra, sale.fechaVenta),
      };
    }).filter(Boolean) as Array<{ id: number; productoId: number; category: string; name: string; model: string; state: string; date: string; purchaseDate: string; units: number; income: number; cost: number | null; profit: number | null; days: number | null }>;

    const totals = financialTotals(saleRows);
    const paymentRows = this.gastoRepo && saleRows.length ? await this.gastoRepo.find({ where: { saleId: In(saleRows.map((row) => row.id)) } }) : [];
    const coveredSaleIds = new Set(paymentRows.filter((row) => row.concepto === 'ingreso' && row.saleId).map((row) => Number(row.saleId)));
    const collectedVerified = paymentRows.length ? roundMoney(paymentRows.filter((row) => row.concepto === 'ingreso' && row.saleId)
      .reduce((sum, row) => sum + Number(row.saleReceivedAmount ?? (row.salePaymentType === 'direct' ? row.montoPen ?? row.monto : 0)), 0)) : null;
    const allPurchases = selectedProducts.filter((product) => product.valor && (!seller || productoShareForSeller(product, seller) > 0));
    const purchased = allPurchases.filter((product) => inRange(product.valor?.fechaCompra));
    const purchasedCost = purchased.reduce((sum, product) => sum + (productCost(product) || 0) * productoShareForSeller(product, seller), 0);
    const purchasedMissing = purchased.filter((product) => productCost(product) == null).length;
    const allPurchaseMissing = allPurchases.filter((product) => productCost(product) == null).length;
    const soldIds = new Set(ventas.filter((sale) => String(productsById.get(sale.productoId)?.tipo || '').toLowerCase() !== 'accesorios').map((sale) => sale.productoId));
    const inventoryRows = selectedProducts.filter((product) => !seller || productoShareForSeller(product, seller) > 0).map((product) => {
      const accessory = String(product.tipo).toLowerCase() === 'accesorios';
      const units = accessory ? Math.max(0, Number(product.stockActual || 0)) : soldIds.has(product.id) ? 0 : 1;
      if (!units) return null;
      const cost = productCost(product);
      const share = productoShareForSeller(product, seller);
      const purchaseDate = dateKey(product.valor?.fechaCompra);
      const tracking = [...(product.tracking || [])].sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
      const status = accessory && product.soloInventario ? 'disponible'
        : String(tracking?.estado || 'comprado_sin_tracking');
      return {
        id: product.id, name: productDisplayClean(product), category: String(product.tipo).toLowerCase(),
        units: units * share, capital: cost == null ? null : roundMoney(cost * units / Math.max(1, accessory ? Number(product.stockInicial || 1) : 1) * share),
        purchaseDate, daysSincePurchase: daysBetween(purchaseDate, businessToday()), status,
      };
    }).filter(Boolean) as Array<{ id: number; name: string; category: string; units: number; capital: number | null; purchaseDate: string; daysSincePurchase: number | null; status: string }>;
    const inventoryMissing = inventoryRows.filter((row) => row.capital == null).length;
    const inventoryCapital = inventoryMissing ? null : roundMoney(inventoryRows.reduce((sum, row) => sum + Number(row.capital), 0));
    const recoveredCapital = totals.cost;
    const capitalInvested = allPurchaseMissing ? null : roundMoney(allPurchases.reduce((sum, product) => sum + productCost(product)! * productoShareForSeller(product, seller), 0));
    const purchaseCapitalInPeriod = purchasedMissing ? null : roundMoney(purchasedCost);
    const days = saleRows.filter((row) => row.days != null && row.days >= 0).map((row) => row.days!);

    const categories = Array.from(new Set([...purchased.map((p) => String(p.tipo).toLowerCase()), ...saleRows.map((r) => r.category), ...inventoryRows.map((r) => r.category)])).map((category) => {
      const purchases = purchased.filter((product) => String(product.tipo).toLowerCase() === category);
      const rows = saleRows.filter((row) => row.category === category);
      const total = financialTotals(rows);
      const categoryDays = rows.filter((row) => row.days != null && row.days >= 0).map((row) => row.days!);
      return {
        category,
        purchased: purchases.reduce((sum, product) => sum + (String(product.tipo).toLowerCase() === 'accesorios' ? Number(product.stockInicial || 0) : 1) * productoShareForSeller(product, seller), 0),
        sold: roundMoney(rows.reduce((sum, row) => sum + row.units, 0)),
        ...total,
        medianDays: median(categoryDays),
        roiRealized: total.cost && total.grossProfit != null ? roundMoney(total.grossProfit / total.cost * 100) : null,
        sample: rows.length,
      };
    }).sort((a, b) => (b.grossProfit ?? -Infinity) - (a.grossProfit ?? -Infinity));
    const aggregateSales = (key: 'model' | 'state') => [...new Set(saleRows.map((row) => row[key]))].map((name) => {
      const rows = saleRows.filter((row) => row[key] === name);
      const amounts = financialTotals(rows);
      const elapsed = rows.filter((row) => row.days != null && row.days >= 0).map((row) => row.days!);
      return { name, sales: rows.length, units: roundMoney(rows.reduce((sum, row) => sum + row.units, 0)), ...amounts,
        profitPerUnit: amounts.grossProfit == null ? null : roundMoney(amounts.grossProfit / Math.max(1, rows.reduce((sum, row) => sum + row.units, 0))),
        medianDays: median(elapsed),
        profitPerCapitalDay: amounts.grossProfit != null && amounts.cost && elapsed.length === rows.length
          ? roundMoney(amounts.grossProfit / amounts.cost / Math.max(1, mean(elapsed)!) * 100) : null,
      };
    }).sort((a, b) => (b.grossProfit ?? -Infinity) - (a.grossProfit ?? -Infinity));

    const periods = new Map<string, { period: string; purchases: number; income: number; cost: number; missingCosts: number }>();
    const at = (date: string) => {
      const key = periodOf(date);
      if (!periods.has(key)) periods.set(key, { period: key, purchases: 0, income: 0, cost: 0, missingCosts: 0 });
      return periods.get(key)!;
    };
    for (const product of purchased) {
      const row = at(dateKey(product.valor?.fechaCompra));
      row.purchases += (productCost(product) || 0) * productoShareForSeller(product, seller);
    }
    for (const row of saleRows) {
      const period = at(row.date);
      period.income += row.income;
      if (row.cost == null) period.missingCosts++;
      else period.cost += row.cost;
    }
    const evolution = Array.from(periods.values()).sort((a, b) => a.period.localeCompare(b.period)).map((row) => ({
      period: row.period,
      purchases: roundMoney(row.purchases),
      income: roundMoney(row.income),
      cost: row.missingCosts ? null : roundMoney(row.cost),
      grossProfit: row.missingCosts ? null : roundMoney(row.income - row.cost),
      missingCosts: row.missingCosts,
    }));
    const agingBounds = [15, 30, 60];
    const aging = ['0-15', '16-30', '31-60', '60+'].map((label, index) => {
      const rows = inventoryRows.filter((row) => {
        const value = row.daysSincePurchase;
        return value != null && (index === 0 ? value <= agingBounds[0]
          : index === 1 ? value > agingBounds[0] && value <= agingBounds[1]
          : index === 2 ? value > agingBounds[1] && value <= agingBounds[2]
          : value > agingBounds[2]);
      });
      return { label, units: roundMoney(rows.reduce((sum, row) => sum + row.units, 0)), capital: rows.some((row) => row.capital == null) ? null : roundMoney(rows.reduce((sum, row) => sum + Number(row.capital), 0)), records: rows };
    });
    const statusOf = (status: string) => {
      if (['recogido', 'disponible', 'en_almacen'].includes(status)) return 'Disponible en Lima';
      if (status.includes('eshopex')) return 'En Eshopex';
      if (status === 'comprado_sin_tracking') return 'Sin tracking';
      return 'En tránsito / pendiente';
    };
    const inventoryByStatus = [...new Set(inventoryRows.map((row) => statusOf(row.status)))].map((status) => {
      const rows = inventoryRows.filter((row) => statusOf(row.status) === status);
      return { status, units: roundMoney(rows.reduce((sum, row) => sum + row.units, 0)), capital: rows.some((row) => row.capital == null) ? null : roundMoney(rows.reduce((sum, row) => sum + Number(row.capital), 0)), records: rows };
    });
    const insights: Array<{ title: string; detail: string; action: string; level: string; category?: string }> = [];
    const slow = inventoryRows.filter((row) => row.daysSincePurchase != null && row.daysSincePurchase > 60);
    if (slow.length) insights.push({ title: 'Capital con más de 60 días', detail: `${slow.length} lotes o equipos siguen sin venderse.`, action: 'Revisar precios y fichas del inventario.', level: 'warning' });
    const losing = saleRows.filter((row) => row.profit != null && row.profit < 0);
    if (losing.length) insights.push({ title: 'Ventas con pérdida', detail: `${losing.length} ventas quedaron por debajo de su costo histórico.`, action: 'Revisar las ventas y el precio mínimo.', level: 'warning' });
    const best = categories.find((row) => row.sample >= 3 && row.grossProfit != null && row.medianDays != null);
    if (best) insights.push({ title: `Oportunidad en ${best.category}`, detail: `${best.sample} ventas, margen ${best.margin}% y mediana ${best.medianDays} días.`, action: 'Comparar existencias y costos recientes antes de comprar.', level: 'info', category: best.category });
    if (totals.missingCosts) insights.unshift({ title: 'Costos incompletos', detail: `${totals.missingCosts} ventas no tienen costo verificable.`, action: 'Completar el costo de compra de sus lotes.', level: 'warning' });

    const today = businessToday();
    const currentMonth = today.slice(0, 7);
    const projectionRows = ventas.filter((sale) => selectedIds.has(sale.productoId) && sale.fechaVenta).map((sale) => {
      const historicalCost = saleCost(sale, productsById);
      const part = seller ? sellerMetrics(sale, seller, 'venta', historicalCost) : null;
      if (seller && !part) return null;
      return { date: String(sale.fechaVenta).slice(0, 10), income: part ? part.income : Number(sale.precioVenta || 0), cost: historicalCost == null ? null : part ? part.cost : historicalCost };
    }).filter(Boolean) as Array<{ date: string; income: number; cost: number | null }>;
    const completedMonths = [...new Set(projectionRows.map((row) => row.date.slice(0, 7)).filter((month) => /^\d{4}-\d{2}$/.test(month) && month < currentMonth))].sort().slice(-3);
    const projection = completedMonths.length < 3 ? null : (() => {
      const monthTotals = completedMonths.map((month) => financialTotals(projectionRows.filter((row) => row.date.startsWith(month))));
      if (monthTotals.some((row) => row.missingCosts)) return null;
      const currentRows = projectionRows.filter((row) => row.date.startsWith(currentMonth));
      const currentTotals = financialTotals(currentRows);
      if (currentTotals.missingCosts) return null;
      const day = Number(today.slice(8, 10));
      const daysInMonth = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();
      const historyIncome = monthTotals.reduce((sum, row) => sum + row.income, 0) / 3;
      const historyProfit = monthTotals.reduce((sum, row) => sum + Number(row.grossProfit), 0) / 3;
      const estimate = (actual: number, history: number) => roundMoney(actual + (history / daysInMonth) * (daysInMonth - day));
      const range = (actual: number, key: 'income' | 'grossProfit') => {
        const values = monthTotals.map((row) => Number(row[key] || 0));
        return [estimate(actual, Math.min(...values)), estimate(actual, Math.max(...values))];
      };
      return {
        income: estimate(currentTotals.income, historyIncome),
        grossProfit: estimate(Number(currentTotals.grossProfit), historyProfit),
        incomeRange: range(currentTotals.income, 'income'),
        grossProfitRange: range(Number(currentTotals.grossProfit), 'grossProfit'),
        actualIncome: currentTotals.income,
        actualGrossProfit: currentTotals.grossProfit,
        sampleMonths: completedMonths,
        method: 'Real acumulado más promedio diario de los tres meses completos anteriores por los días restantes.',
      };
    })();
    const budget = Number(params.budget || 0);
    const strategy = params.strategy || 'balanced';
    const investment = budget > 0 ? categories
      .filter((row) => row.sample >= 3 && row.cost != null && row.cost > 0 && row.grossProfit != null && row.grossProfit > 0 && row.sold > 0)
      .map((row) => {
        const unitCost = row.cost! / row.sold;
        const unitProfit = row.grossProfit! / row.sold;
        const speed = row.medianDays == null ? 0 : 1 / Math.max(1, row.medianDays);
        const score = strategy === 'profit' ? unitProfit / unitCost : strategy === 'speed' ? speed : (unitProfit / unitCost) * speed;
        return { category: row.category, unitCost: roundMoney(unitCost), unitProfit: roundMoney(unitProfit), medianDays: row.medianDays, sample: row.sample, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((row) => ({ ...row, affordableUnits: Math.floor(budget / row.unitCost), historicalPotential: roundMoney(Math.floor(budget / row.unitCost) * row.unitProfit) })) : [];
    const comparableTo = params.to && params.to > today ? today : params.to;
    const previousRange = params.from && comparableTo && params.from <= comparableTo ? computePreviousRange(params.from, comparableTo) : null;
    const comparison = previousRange ? (() => {
      const previousSales = ventas.filter((sale) => selectedIds.has(sale.productoId)
        && String(sale.fechaVenta || '').slice(0, 10) >= previousRange.from
        && String(sale.fechaVenta || '').slice(0, 10) <= previousRange.to).map((sale) => {
        const historicalCost = saleCost(sale, productsById);
        const part = seller ? sellerMetrics(sale, seller, 'venta', historicalCost) : null;
        if (seller && !part) return null;
        return { income: part ? part.income : Number(sale.precioVenta || 0), cost: historicalCost == null ? null : part ? part.cost : historicalCost };
      }).filter(Boolean) as Array<{ income: number; cost: number | null }>;
      const previousTotals = financialTotals(previousSales);
      const previousPurchases = selectedProducts.filter((product) =>
        dateKey(product.valor?.fechaCompra) >= previousRange.from
        && dateKey(product.valor?.fechaCompra) <= previousRange.to
        && (!seller || productoShareForSeller(product, seller) > 0));
      const previousCapital = previousPurchases.some((product) => productCost(product) == null) ? null
        : roundMoney(previousPurchases.reduce((sum, product) => sum + productCost(product)! * productoShareForSeller(product, seller), 0));
      return { range: previousRange, income: previousTotals.income, cost: previousTotals.cost, grossProfit: previousTotals.grossProfit, markup: previousTotals.markup, purchaseCapitalInPeriod: previousCapital };
    })() : null;

    return {
      currency: 'PEN', filters: params,
      definitions: {
        income: 'Ventas registradas por fecha de venta; no equivale a dinero cobrado.',
        cost: 'Costo histórico de las unidades vendidas, incluidos los envíos prorrateados registrados.',
        capital: 'Costo acumulado de todos los productos comprados que coinciden con los filtros de producto y vendedor; no depende del rango de fechas.',
        inventory: 'Valor al costo del stock actual, independiente del filtro de fecha de venta.',
      },
      summary: {
        capitalInvested, purchaseCapitalInPeriod, inventoryCapital, recoveredCapital, income: totals.income,
        cost: totals.cost, grossProfit: totals.grossProfit, margin: totals.margin, markup: totals.markup,
        medianDays: median(days), meanDays: mean(days), profitPerThousand: totals.cost && totals.grossProfit != null ? roundMoney(totals.grossProfit / totals.cost * 1000) : null,
        operatingExpenses: null, operatingResult: null, cashFlow: null,
        collectedVerified, collectionCoverage: saleRows.length ? roundMoney(coveredSaleIds.size / saleRows.length * 100) : null,
        missingCosts: totals.missingCosts, missingPurchaseCosts: allPurchaseMissing, missingInventoryCosts: inventoryMissing,
        expenseStatus: 'Los gastos existentes no separan de forma verificable negocio y gastos personales.',
        cashStatus: 'Los registros de cobros y pagos no cubren todas las operaciones.',
      },
      evolution, categories, models: aggregateSales('model'), states: aggregateSales('state'), inventory: { aging, byStatus: inventoryByStatus, records: inventoryRows },
      sales: saleRows,
      purchases: allPurchases.map((product) => ({
        id: product.id, name: productDisplayClean(product),
        purchaseDate: dateKey(product.valor?.fechaCompra),
        units: (String(product.tipo).toLowerCase() === 'accesorios' ? Number(product.stockInicial || 0) : 1) * productoShareForSeller(product, seller),
        capital: productCost(product) == null ? null : roundMoney(productCost(product)! * productoShareForSeller(product, seller)),
      })),
      insights, projection, investment, comparison,
    };
  }

  async profit(params: ProfitParams) {
    const groupBy = (params.groupBy || 'month') as GroupBy;
    const tipo = params.tipo || (params.type && params.type !== 'general' ? params.type : undefined);
    const { gama, procesador, pantalla, vendedor, from, to } = params;

    const dFrom = parseDate(from);
    const dTo = parseDate(to);

    const { matchesProductFilters } = createAttrsMatcher({
      tipo,
      gama,
      procesador,
      pantalla,
    });
    const { productos: universeProductos, ventas: universeVentas } = await this.getAnalyticsUniverseCached();
    const productsById = new Map(universeProductos.map((product) => [product.id, product]));
    let ventas = universeVentas.filter((v) => {
      if (!v.fechaVenta) return false;
      const fechaVenta = String(v.fechaVenta).slice(0, 10);
      if (dFrom && fechaVenta < String(from)) return false;
      if (dTo && fechaVenta > String(to)) return false;
      return true;
    });

    ventas = ventas.filter((v) => {
      const prod = v.producto as any as Producto | undefined;
      return prod ? matchesProductFilters(prod) : true;
    });

    const sellerTarget = normalizeSeller(vendedor);
    const rows: ProfitInput[] = [];
    for (const v of ventas) {
      if (!v.fechaVenta) continue;
      const historicalCost = saleCost(v, productsById);
      if (historicalCost == null) continue;
      if (sellerTarget) {
        const metrics = sellerMetrics(v, sellerTarget, 'venta', historicalCost);
        if (!metrics) continue;
        rows.push({ fechaVenta: v.fechaVenta, income: metrics.income, cost: metrics.cost });
      } else {
        const costoTotal = historicalCost;
        const income = Number(v.precioVenta ?? 0) || 0;
        rows.push({ fechaVenta: v.fechaVenta, income, cost: costoTotal });
      }
    }

    const resultRows = aggregateProfitByPeriod(rows, { from, to, groupBy });
    return {
      currency: 'PEN',
      groupBy,
      from,
      to,
      rows: resultRows,
    };
  }

  async profitCompare(params: ProfitParams & { from?: string; to?: string }) {
    const groupBy = (params.groupBy || 'month') as GroupBy;
    const tipo = params.tipo || (params.type && params.type !== 'general' ? params.type : undefined);
    const { gama, procesador, pantalla, vendedor } = params;
    const from = params.from;
    const to = params.to;
    if (!from || !to) {
      return {
        current: null,
        previous: null,
        delta: null,
        insights: [],
      };
    }

    const prevRange = computePreviousRange(from, to);
    const ranges = [
      { key: 'current', from, to },
      { key: 'previous', from: prevRange.from, to: prevRange.to },
    ];

    const dFrom = parseDate(prevRange.from);
    const dTo = parseDate(to);

    const { matchesProductFilters } = createAttrsMatcher({
      tipo,
      gama,
      procesador,
      pantalla,
    });
    const { productos: universeProductos, ventas: universeVentas } =
      await this.getAnalyticsUniverseCached();
    const productsById = new Map(universeProductos.map((product) => [product.id, product]));
    let ventas = universeVentas.filter((v) => {
      if (!v.fechaVenta) return false;
      const fechaVenta = String(v.fechaVenta).slice(0, 10);
      if (dFrom && fechaVenta < prevRange.from) return false;
      if (dTo && fechaVenta > String(to)) return false;
      return true;
    });

    ventas = ventas.filter((v) => {
      const prod = v.producto as any as Producto | undefined;
      return prod ? matchesProductFilters(prod) : true;
    });

    const sellerTarget = normalizeSeller(vendedor);

    const metricsByKey = new Map<string, CompareMetric>();
    for (const r of ranges) {
      metricsByKey.set(r.key, { income: 0, cost: 0, profit: 0, margin: 0, purchases: 0, orders: 0, avgTicket: 0 });
    }

    const topProductMap = new Map<string, { name: string; profit: number }>();

    const toYmd = (value: unknown) => {
      if (!value) return '';
      const d = value instanceof Date ? value : new Date(value as any);
      if (isNaN(d.getTime())) return '';
      return d.toISOString().slice(0, 10);
    };

    const inRange = (dateStr: string, start: string, end: string) => {
      const s = String(dateStr || '').slice(0, 10);
      return s >= start && s <= end;
    };

    for (const v of ventas) {
      if (!v.fechaVenta) continue;
      const historicalCost = saleCost(v, productsById);
      if (historicalCost == null) continue;
      const vDateStr = String(v.fechaVenta).slice(0, 10);
      if (!vDateStr) continue;
      if (sellerTarget) {
        const metrics = sellerMetrics(v, sellerTarget, 'venta', historicalCost);
        if (!metrics) continue;
        const cost = metrics.cost;
        const income = metrics.income;
        const profit = income - cost;
        if (inRange(vDateStr, from, to)) {
          const curr = metricsByKey.get('current')!;
          curr.income += income;
          curr.cost += cost;
          curr.profit += profit;
          curr.orders = (curr.orders || 0) + 1;
          const name = v.producto ? productDisplayClean(v.producto as any) : `#${v.productoId}`;
          const top = topProductMap.get(name) || { name, profit: 0 };
          top.profit += profit;
          topProductMap.set(name, top);
        }
        if (inRange(vDateStr, prevRange.from, prevRange.to)) {
          const prev = metricsByKey.get('previous')!;
          prev.income += income;
          prev.cost += cost;
          prev.profit += profit;
          prev.orders = (prev.orders || 0) + 1;
        }
        continue;
      }
      const cost = historicalCost;
      const income = Number(v.precioVenta ?? 0) || 0;
      const profit = income - cost;

      if (inRange(vDateStr, from, to)) {
        const curr = metricsByKey.get('current')!;
        curr.income += income;
        curr.cost += cost;
        curr.profit += profit;
        curr.orders = (curr.orders || 0) + 1;
        const name = v.producto ? productDisplayClean(v.producto as any) : `#${v.productoId}`;
        const top = topProductMap.get(name) || { name, profit: 0 };
        top.profit += profit;
        topProductMap.set(name, top);
      }
      if (inRange(vDateStr, prevRange.from, prevRange.to)) {
        const prev = metricsByKey.get('previous')!;
        prev.income += income;
        prev.cost += cost;
        prev.profit += profit;
        prev.orders = (prev.orders || 0) + 1;
      }
    }

    const compras = universeProductos.filter(
      (p) => matchesProductFilters(p) && (!sellerTarget || matchesProductoSeller(p, sellerTarget)),
    );

    for (const p of compras) {
      const compraDate = toYmd(p.valor?.fechaCompra || '');
      if (!compraDate) continue;
      const share = productoShareForSeller(p, sellerTarget);
      if (share <= 0) continue;
      const costoTotal = (Number(p.valor?.costoTotal ?? 0) || 0) * share;
      if (inRange(compraDate, from, to)) {
        const curr = metricsByKey.get('current')!;
        curr.purchases = (curr.purchases || 0) + costoTotal;
      }
      if (inRange(compraDate, prevRange.from, prevRange.to)) {
        const prev = metricsByKey.get('previous')!;
        prev.purchases = (prev.purchases || 0) + costoTotal;
      }
    }

    const finalizeMetric = (m: CompareMetric) => {
      m.income = +m.income.toFixed(2);
      m.cost = +m.cost.toFixed(2);
      m.profit = +(m.income - m.cost).toFixed(2);
      if (m.purchases != null) m.purchases = +m.purchases.toFixed(2);
      m.margin = m.income > 0 ? +((m.profit / m.income) * 100).toFixed(2) : 0;
      const orders = Number(m.orders || 0);
      m.avgTicket = orders > 0 ? +(m.income / orders).toFixed(2) : 0;
      return m;
    };

    const current = finalizeMetric(metricsByKey.get('current')!);
    const previous = finalizeMetric(metricsByKey.get('previous')!);
    const delta = computeDeltas(current, previous);
    const topProducts = Array.from(topProductMap.values())
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 5);
    const insights = buildInsights({ current, previous, delta, topProducts });

    return {
      groupBy,
      from,
      to,
      previousRange: prevRange,
      current,
      previous,
      delta,
      insights,
      topProducts,
    };
  }

  async sunatExchangeRate(date?: string) {
    const dateKey = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : 'today';
    const cacheKey = appCacheKey(this.cache, `analytics:sunat:fx:v2:${dateKey}`);
    const cached = await this.cache.get<any>(cacheKey);
    if (cached) return cached;

    const token =
      process.env.DECOLECTA_API_TOKEN ||
      process.env.APIS_NET_PE_TOKEN ||
      process.env.APIS_TOKEN ||
      '';

    const params = new URLSearchParams();
    if (dateKey !== 'today') params.set('date', dateKey);
    const query = params.toString();
    const url = `https://api.decolecta.com/v1/tipo-cambio/sunat${query ? `?${query}` : ''}`;

    try {
      const todayYmd = (() => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      })();
      const baseDate = dateKey === 'today' ? todayYmd : dateKey;
      const minusDays = (ymd: string, days: number) => {
        const [y, m, d] = ymd.split('-').map((x) => Number(x));
        const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
        dt.setUTCDate(dt.getUTCDate() - days);
        return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
      };

      // Public SUNAT mirror without token. Try target day and a few previous days (weekend/holiday safe).
      let publicReason = 'public source not attempted';
      for (let i = 0; i <= 7; i += 1) {
        const d = minusDays(baseDate, i);
        const pubUrl = `https://free.e-api.net.pe/tipo-cambio/${d}.json`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const resp = await fetch(pubUrl, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: controller.signal,
          });
          clearTimeout(timeout);
          if (!resp.ok) {
            publicReason = `public-eapi: HTTP ${resp.status}`;
            continue;
          }
          const body: any = await resp.json();
          const buy = Number(body?.compra ?? body?.buy ?? body?.buy_price ?? body?.sunat);
          const sell = Number(body?.venta ?? body?.sell ?? body?.sell_price ?? body?.sunat);
          const fxDate = String(body?.fecha ?? body?.date ?? d).slice(0, 10);
          if (!isFinite(buy) || !isFinite(sell) || sell <= 0) {
            publicReason = 'public-eapi: invalid payload';
            continue;
          }
          const result = {
            source: 'sunat-eapi',
            buy: +buy.toFixed(3),
            sell: +sell.toFixed(3),
            date: fxDate || d,
            fallback: false,
            authMode: 'public-eapi',
            reason: '',
          };
          await this.cache.set(cacheKey, result, 3_600_000);
          return result;
        } catch (e: any) {
          clearTimeout(timeout);
          publicReason = `public-eapi: ${String(e?.message || 'request error').slice(0, 120)}`;
        }
      }

      const parseBody = (body: any) => {
        const buy = Number(body?.buy_price ?? body?.compra ?? body?.buyPrice);
        const sell = Number(body?.sell_price ?? body?.venta ?? body?.sellPrice);
        const fxDate = String(body?.date || dateKey || '').slice(0, 10);
        if (!isFinite(buy) || !isFinite(sell) || sell <= 0) return null;
        return {
          source: 'sunat',
          buy: +buy.toFixed(3),
          sell: +sell.toFixed(3),
          date: fxDate || null,
          fallback: false,
          authMode: null as string | null,
          reason: '',
        };
      };

      const attempts: { authMode: string; reqUrl: string; headers: Record<string, string> }[] = [];
      const baseHeaders: Record<string, string> = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Referer: 'https://apis.net.pe/tipo-de-cambio-sunat-api',
      };
      attempts.push({ authMode: 'none', reqUrl: url, headers: { ...baseHeaders } });
      if (token) {
        attempts.push({ authMode: 'bearer', reqUrl: url, headers: { ...baseHeaders, Authorization: `Bearer ${token}` } });
        attempts.push({ authMode: 'apikey-header', reqUrl: url, headers: { ...baseHeaders, apikey: token } });
        attempts.push({
          authMode: 'api_token-query',
          reqUrl: `${url}${url.includes('?') ? '&' : '?'}api_token=${encodeURIComponent(token)}`,
          headers: { ...baseHeaders },
        });
        attempts.push({
          authMode: 'apikey-query',
          reqUrl: `${url}${url.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(token)}`,
          headers: { ...baseHeaders },
        });
      }

      let lastReason = publicReason || 'unknown';
      for (const attempt of attempts) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const resp = await fetch(attempt.reqUrl, {
            method: 'GET',
            headers: attempt.headers,
            signal: controller.signal,
          });
          clearTimeout(timeout);
          const text = await resp.text();
          let body: any = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = null;
          }
          if (!resp.ok) {
            const errMsg = body?.error || body?.message || text || `HTTP ${resp.status}`;
            lastReason = `${attempt.authMode}: HTTP ${resp.status} - ${String(errMsg).slice(0, 160)}`;
            continue;
          }
          const parsed = parseBody(body);
          if (!parsed) {
            lastReason = `${attempt.authMode}: invalid payload`;
            continue;
          }
          parsed.authMode = attempt.authMode;
          await this.cache.set(cacheKey, parsed, 3_600_000);
          return parsed;
        } catch (e: any) {
          clearTimeout(timeout);
          const msg = e?.message || 'request error';
          lastReason = `${attempt.authMode}: ${String(msg).slice(0, 160)}`;
        }
      }

      throw new Error(lastReason);
    } catch (e: any) {
      const reason = String(e?.message || 'fallback').slice(0, 180);
      const fallback = {
        source: 'fallback',
        buy: this.fallbackTc,
        sell: this.fallbackTc,
        date: dateKey === 'today' ? null : dateKey,
        fallback: true,
        authMode: null,
        reason,
      };
      await this.cache.set(cacheKey, fallback, 300_000);
      return fallback;
    }
  }
}
