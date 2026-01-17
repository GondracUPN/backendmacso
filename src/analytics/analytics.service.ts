import { Injectable, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Cache } from 'cache-manager';
import { Producto } from '../producto/producto.entity';
import { ProductoValor } from '../producto/producto-valor.entity';
import { ProductoDetalle } from '../producto/producto-detalle.entity';
import { Tracking } from '../tracking/tracking.entity';
import { Venta } from '../venta/venta.entity';
import { aggregateProfitByPeriod, type GroupBy, type ProfitInput } from './profit.utils';
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
const normalizeSeller = (s?: string | null) => (s == null ? '' : String(s).trim().toLowerCase());
const shareForSeller = (venta: Venta, seller: string) => {
  const vend = normalizeSeller(venta?.vendedor as any);
  if (!seller) return 1;
  if (!vend) return 0;
  if (vend === seller) return 1;
  if (vend === SPLIT_VENDOR) return 0.5;
  return 0;
};

// Versión limpia para armar un display legible del producto sin caracteres extraños
function productDisplayClean(p: Producto): string {
  const tipo = (p.tipo || '').toLowerCase();
  const d: any = p.detalle || {};

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
  ) {}

  private readonly inflight = new Set<string>();

  private buildKey(prefix: string, params: Params): string {
    const entries = Object.entries(params || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `${prefix}:${entries.map(([k, v]) => `${k}=${v}`).join('&')}`;
  }

  // Stale‑while‑revalidate wrapper for the heavy summary aggregation
  async summaryCached(params: Params) {
    const key = this.buildKey('analytics:summary', params);
    const cached: any = await this.cache.get(key);
    const now = Date.now();
    const revalidateMs = 120_000; // recompute in background every 2 min if accessed
    const ttlSeconds = 600; // keep in cache 10 min (served as stale if needed)

    if (cached?.data) {
      const age = now - (cached.cachedAt || 0);
      if (age > revalidateMs && !this.inflight.has(key)) {
        this.inflight.add(key);
        this.summary(params)
          .then((data) => this.cache.set(key, { data, cachedAt: Date.now() }, ttlSeconds))
          .finally(() => this.inflight.delete(key));
      }
      return cached.data;
    }

    const data = await this.summary(params);
    await this.cache.set(key, { data, cachedAt: now }, ttlSeconds);
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

    type Attrs = { tipo: string; gama: string; proc: string; pantalla: string; ram: string; ssd: string };
    const attrsCache = new Map<number, Attrs>();
    const extractAttrs = (p: Producto): Attrs => {
      let tipoP = (p.tipo || '').toLowerCase().trim();
      if (tipoP.includes('watch')) tipoP = 'watch';
      const d: any = p.detalle || {};
      const sanitize = (s: string) => s?.toString()?.toLowerCase()?.normalize('NFD')?.replace(/[\u0300-\u036f]/g, '') || '';
      let gama = d?.gama ? String(d.gama).trim() : '';
      let proc = '';
      for (const key of Object.keys(d || {})) {
        const k = sanitize(key);
        if (k.includes('procesador') || k === 'cpu' || k.includes('chip') || k.startsWith('proc')) { proc = String(d[key] ?? ''); break; }
      }
      proc = proc ? proc.replace(/\s+/g, ' ').trim() : '';
      let pantalla = '';
      const known = ['10.2','10.9','11','12.9','13','14','15','16'];
      for (const key of Object.keys(d || {})) {
        const k = sanitize(key);
        if (k.includes('tamano')||k.includes('tamanio')||k.includes('tamanopantalla')||k.includes('pantalla')||k.includes('screen')||k.includes('size')||k==='tam') { pantalla = String(d[key] ?? ''); break; }
      }
      if (!pantalla) {
        const candidates = Object.values(d || {}).filter((v)=> typeof v === 'string') as string[];
        const hit = candidates.map(String).find(vs => known.find(x => vs.includes(x)));
        if (hit) pantalla = known.find(x => String(hit).includes(x)) || '';
      }
      const m = String(pantalla).match(/\d+(?:\.\d+)?/);
      pantalla = m ? m[0] : (pantalla || '');
      if (!gama && (tipoP === 'iphone' || tipoP === 'watch' || tipoP === 'ipad')) {
        const modelo = d?.modelo ? String(d.modelo).trim() : '';
        if (modelo) gama = modelo;
      }
      const ram = d?.ram ? String(d.ram).trim() : '';
      const ssd = (d as any)?.almacenamiento || (d as any)?.ssd ? String((d as any)?.almacenamiento || (d as any)?.ssd).trim() : '';
      return { tipo: tipoP, gama, proc, pantalla, ram, ssd };
    };
    const getAttrs = (p: Producto): Attrs => {
      const existing = attrsCache.get(p.id);
      if (existing) return existing;
      const parsed = extractAttrs(p);
      attrsCache.set(p.id, parsed);
      return parsed;
    };
    const matchesProductFilters = (p: Producto) => {
      const attrs = getAttrs(p);
      if (tipo && attrs.tipo !== tipo) return false;
      if (gama && attrs.gama !== gama) return false;
      if (procesador && attrs.proc !== procesador) return false;
      if (pantalla && attrs.pantalla !== pantalla) return false;
      return true;
    };

    // Load products + relations for inventory-level metrics
    const productos = await this.prodRepo.find({
      relations: ['valor', 'detalle', 'tracking'],
      order: { id: 'DESC' },
    });

    // Load ventas with joins for sales-level metrics
    const ventaQB = this.ventaRepo
      .createQueryBuilder('v')
      .leftJoinAndSelect('v.producto', 'p')
      .leftJoinAndSelect('p.valor', 'val')
      .leftJoinAndSelect('p.detalle', 'det');
    if (dFromVenta) ventaQB.andWhere('v.fechaVenta >= :fv', { fv: fromVenta });
    if (dToVenta) ventaQB.andWhere('v.fechaVenta <= :tv', { tv: toVenta });
    if (tipo) ventaQB.andWhere('p.tipo = :tipo', { tipo });
    let ventas = await ventaQB.orderBy('v.fechaVenta', 'DESC').addOrderBy('v.id', 'DESC').getMany();

    // Map rápido para acceder al producto completo (incluye tracking)
    const productoById = new Map<number, Producto>();
    for (const p of productos) productoById.set(p.id, p);

    // Filtra ventas por filtros de producto (gama/proc/pantalla/tipo)
    ventas = ventas.filter((v) => {
      const prod = productoById.get(v.productoId) || (v.producto as any as Producto | undefined);
      return prod ? matchesProductFilters(prod) : true;
    });

    // Ensure ganancia is available for analytics (fallback to precioVenta - costoTotal)
    for (const v of ventas) {
      const curr = Number(v.ganancia);
      if (v.ganancia != null && isFinite(curr)) continue;
      const costoTotal =
        Number(v.producto?.valor?.costoTotal ?? productoById.get(v.productoId)?.valor?.costoTotal ?? 0) || 0;
      const precioVenta = Number(v.precioVenta ?? 0) || 0;
      const computed = precioVenta - costoTotal;
      if (isFinite(computed)) v.ganancia = computed as any;
    }

    const sellerTarget = normalizeSeller(vendedor);
    if (sellerTarget) {
      ventas = ventas
        .map((v) => {
          const share = shareForSeller(v, sellerTarget);
          if (!share) return null;
          if (share === 1) return v;
          return {
            ...v,
            precioVenta: Number(v.precioVenta ?? 0) * share,
            ganancia: Number(v.ganancia ?? 0) * share,
          } as Venta;
        })
        .filter(Boolean) as Venta[];
    }

    // Build helper maps
    const ventasByProducto = groupBy(ventas, (v) => v.productoId);
    // Para stock activo, necesitamos saber todos los productos vendidos históricamente
    const ventasAllMin = await this.ventaRepo.find({ select: { productoId: true } as any });
    const vendidosHistoricos = new Set<number>(ventasAllMin.map((x: any) => x.productoId));

    // Filtered products view for inventory calculations
    const productosFiltered = productos.filter((p) => {
      if (!matchesProductFilters(p)) return false;
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

    // Helper to build a user-friendly display for each product
    const productDisplay = (p: Producto): string => {
      const tipo = (p.tipo || '').toLowerCase();
      const d: any = p.detalle || {};

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
    const latestTrackingEstado = (p: Producto) => {
      const trk = Array.isArray(p.tracking) ? [...p.tracking] : [];
      if (!trk.length) return '';
      trk.sort((a, b) => {
        if (a.createdAt && b.createdAt) {
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        }
        return (b.id || 0) - (a.id || 0);
      });
      return String(trk[0]?.estado || '').toLowerCase();
    };

    const unsold = productosFiltered.filter((p) => !vendidosHistoricos.has(p.id));
    const inventoryUnsoldUnits = unsold.length;
    const inventoryAvailableUnits = unsold.filter((p) => latestTrackingEstado(p) === 'recogido').length;
    const inventoryActiveUnits = inventoryUnsoldUnits;
    const capitalInmovilizado = +(
      unsold.reduce((s, p) => s + (Number(p.valor?.costoTotal ?? 0) || 0), 0)
    ).toFixed(2);

    // Compras del período (filtradas por fecha de compra)
    const comprasPeriodoUnidades = productosFiltered.length;
    const comprasPeriodoCapital = +(
      productosFiltered.reduce((s, p) => s + (Number(p.valor?.costoTotal ?? 0) || 0), 0)
    ).toFixed(2);
    // Capital total = suma de todo lo comprado en el universo filtrado (por fecha/tipo que aplique)
    const capitalTotal = comprasPeriodoCapital;
    const comprasPeriodo = productosFiltered.map((p) => ({
      productoId: p.id,
      tipo: p.tipo,
      display: productDisplayClean(p),
      fechaCompra: p.valor?.fechaCompra,
      costoTotal: Number(p.valor?.costoTotal ?? 0) || 0,
    }));

    // No vendidos del período (comprados en el período y aún sin vender)
    const nowForNoVendidos = new Date();
    const noVendidosDelPeriodo = productosFiltered
      .filter((p) => !vendidosHistoricos.has(p.id))
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
          costoTotal: Number(p.valor?.costoTotal ?? 0) || 0,
          fechaCompra: p.valor?.fechaCompra,
          fechaRecogido: frg || null,
          diasDesdeRecogido: dias,
        };
      });

    // Inventory by type for current unsold
    const byTypeMap = new Map<string, { unidades: number; capital: number }>();
    for (const p of unsold) {
      const k = p.tipo || 'otro';
      const curr = byTypeMap.get(k) || { unidades: 0, capital: 0 };
      curr.unidades += 1;
      curr.capital += Number(p.valor?.costoTotal ?? 0) || 0;
      byTypeMap.set(k, curr);
    }
    const inventoryByType = Array.from(byTypeMap.entries()).map(([tipo, v]) => ({
      tipo,
      unidades: v.unidades,
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
        return { month, ingresos, ganancia, margenPromedio: +(margenPromedio?.toFixed(3) || 0) };
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
    const vendidosPeriodoByTipo = new Map<string, { productoId: number; display: string; fechaVenta?: string | null; precioVenta?: number | null; margen?: number | null }[]>();
    for (const v of ventas) {
      const t = v.producto?.tipo || 'otro';
      const arr = vendidosPeriodoByTipo.get(t) || [];
      if (v.producto) {
        arr.push({
          productoId: v.productoId,
          display: productDisplayClean(v.producto as any),
          fechaVenta: v.fechaVenta,
          precioVenta: Number(v.precioVenta),
          margen: Number(v.porcentajeGanancia),
        });
      }
      vendidosPeriodoByTipo.set(t, arr);
    }
    // Stock actual independiente del filtro de ventas (productos sin ninguna venta histórica)
    const ventasAll = await this.ventaRepo.find();
    const ventasAllByProducto = new Map<number, boolean>();
    for (const vv of ventasAll) ventasAllByProducto.set(vv.productoId, true);
    const stockActual = productos.filter((p) => !ventasAllByProducto.get(p.id) && matchesProductFilters(p));
    const stockByTipo = new Map<string, { productoId: number; display: string }[]>();
    for (const p of stockActual) {
      if (tipo && p.tipo !== tipo) continue;
      const t = p.tipo || 'otro';
      const arr = stockByTipo.get(t) || [];
      arr.push({ productoId: p.id, display: productDisplayClean(p) });
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
        vendidos: { total: ven.length, items: ven },
        stock: { total: stk.length, items: stk },
      };
    });
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
    type CompraDetalle = { productoId: number; fechaCompra?: string | Date | null; precioUSD?: number | null; costoTotal?: number | null; estado?: string | null; };
    type VentaDetalle = { ventaId: number; productoId: number; fechaVenta?: string | Date | null; precioVenta?: number | null; ganancia?: number | null; porcentaje?: number | null; dias?: number | null; };
    type Group = {
      tipo: string;
      gama: string;
      proc: string;
      pantalla: string;
      compras: number[];
      ventas: number[];
      margenes: number[];
      comprasDet: CompraDetalle[];
      ventasDet: VentaDetalle[];
      ramSet: Set<string>;
      ssdSet: Set<string>;
    };
    const groups = new Map<GroupKey, Group>();
    for (const p of productosFiltered) {
      const a = getAttrs(p);
      const k: GroupKey = [a.tipo || 'otro', a.gama || '-', a.proc || '-', a.pantalla || '-'].join('|');
      const g = groups.get(k) || { tipo: a.tipo || 'otro', gama: a.gama || '', proc: a.proc || '', pantalla: a.pantalla || '', compras: [], ventas: [], margenes: [], comprasDet: [], ventasDet: [], ramSet: new Set(), ssdSet: new Set() };
      g.compras.push(Number(p.valor?.costoTotal ?? 0) || 0);
      g.comprasDet.push({
        productoId: p.id,
        fechaCompra: p.valor?.fechaCompra || null,
        precioUSD: Number(p.valor?.valorProducto ?? 0) || null,
        costoTotal: Number(p.valor?.costoTotal ?? 0) || null,
        estado: p.estado || null,
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
      const k: GroupKey = [a.tipo || 'otro', a.gama || '-', a.proc || '-', a.pantalla || '-'].join('|');
      const g = groups.get(k) || { tipo: a.tipo || 'otro', gama: a.gama || '', proc: a.proc || '', pantalla: a.pantalla || '', compras: [], ventas: [], margenes: [], comprasDet: [], ventasDet: [], ramSet: new Set(), ssdSet: new Set() };
      g.ventas.push(Number(v.precioVenta) || 0);
      g.margenes.push(Number(v.porcentajeGanancia) || 0);
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
        precioVenta: Number(v.precioVenta) || null,
        ganancia: Number(v.ganancia) || null,
        porcentaje: Number(v.porcentajeGanancia) || null,
        dias: fechaRecogido ? daysBetween(fechaRecogido, v.fechaVenta) : null,
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
        capitalInmovilizado,
        capitalTotal,
        comprasPeriodoUnidades,
        comprasPeriodoCapital,
        rotationMedianDaysOverall,
        monthlies,
      },
      comprasPeriodo,
      inventoryByType,
      aging,
      logistica,
      noVendidosDelPeriodo,
      sales: {
        perMonth: monthlies,
        marginByType,
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

  async profit(params: ProfitParams) {
    const groupBy = (params.groupBy || 'month') as GroupBy;
    const tipo = params.tipo || (params.type && params.type !== 'general' ? params.type : undefined);
    const { gama, procesador, pantalla, vendedor, from, to } = params;

    const dFrom = parseDate(from);
    const dTo = parseDate(to);

    type Attrs = { tipo: string; gama: string; proc: string; pantalla: string };
    const attrsCache = new Map<number, Attrs>();
    const extractAttrs = (p: Producto): Attrs => {
      let tipoP = (p.tipo || '').toLowerCase().trim();
      if (tipoP.includes('watch')) tipoP = 'watch';
      const d: any = p.detalle || {};
      const sanitize = (s: string) => s?.toString()?.toLowerCase()?.normalize('NFD')?.replace(/[\u0300-\u036f]/g, '') || '';
      let gamaVal = d?.gama ? String(d.gama).trim() : '';
      let procVal = '';
      for (const key of Object.keys(d || {})) {
        const k = sanitize(key);
        if (k.includes('procesador') || k === 'cpu' || k.includes('chip') || k.startsWith('proc')) { procVal = String(d[key] ?? ''); break; }
      }
      procVal = procVal ? procVal.replace(/\s+/g, ' ').trim() : '';
      let pantallaVal = '';
      const known = ['10.2', '10.9', '11', '12.9', '13', '14', '15', '16'];
      for (const key of Object.keys(d || {})) {
        const k = sanitize(key);
        if (k.includes('tamano') || k.includes('tamanio') || k.includes('tamanopantalla') || k.includes('pantalla') || k.includes('screen') || k.includes('size') || k === 'tam') {
          pantallaVal = String(d[key] ?? '');
          break;
        }
      }
      if (!pantallaVal) {
        const candidates = Object.values(d || {}).filter((v) => typeof v === 'string') as string[];
        const hit = candidates.map(String).find((vs) => known.find((x) => vs.includes(x)));
        if (hit) pantallaVal = known.find((x) => String(hit).includes(x)) || '';
      }
      const m = String(pantallaVal).match(/\d+(?:\.\d+)?/);
      pantallaVal = m ? m[0] : (pantallaVal || '');
      if (!gamaVal && (tipoP === 'iphone' || tipoP === 'watch' || tipoP === 'ipad')) {
        const modelo = d?.modelo ? String(d.modelo).trim() : '';
        if (modelo) gamaVal = modelo;
      }
      return { tipo: tipoP, gama: gamaVal, proc: procVal, pantalla: pantallaVal };
    };
    const getAttrs = (p: Producto): Attrs => {
      const existing = attrsCache.get(p.id);
      if (existing) return existing;
      const parsed = extractAttrs(p);
      attrsCache.set(p.id, parsed);
      return parsed;
    };
    const matchesProductFilters = (p: Producto) => {
      const attrs = getAttrs(p);
      if (tipo && attrs.tipo !== tipo) return false;
      if (gama && attrs.gama !== gama) return false;
      if (procesador && attrs.proc !== procesador) return false;
      if (pantalla && attrs.pantalla !== pantalla) return false;
      return true;
    };

    const ventaQB = this.ventaRepo
      .createQueryBuilder('v')
      .leftJoinAndSelect('v.producto', 'p')
      .leftJoinAndSelect('p.valor', 'val')
      .leftJoinAndSelect('p.detalle', 'det');
    if (dFrom) ventaQB.andWhere('v.fechaVenta >= :fv', { fv: from });
    if (dTo) ventaQB.andWhere('v.fechaVenta <= :tv', { tv: to });
    if (tipo && tipo !== 'watch') ventaQB.andWhere('p.tipo = :tipo', { tipo });
    let ventas = await ventaQB.orderBy('v.fechaVenta', 'DESC').addOrderBy('v.id', 'DESC').getMany();

    ventas = ventas.filter((v) => {
      const prod = v.producto as any as Producto | undefined;
      return prod ? matchesProductFilters(prod) : true;
    });

    const sellerTarget = normalizeSeller(vendedor);
    const rows: ProfitInput[] = [];
    for (const v of ventas) {
      if (!v.fechaVenta) continue;
      const share = sellerTarget ? shareForSeller(v, sellerTarget) : 1;
      if (!share) continue;
      const costoTotal = Number(v.producto?.valor?.costoTotal ?? 0) || 0;
      const income = (Number(v.precioVenta ?? 0) || 0) * share;
      const cost = costoTotal * share;
      rows.push({ fechaVenta: v.fechaVenta, income, cost });
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

    type Attrs = { tipo: string; gama: string; proc: string; pantalla: string };
    const attrsCache = new Map<number, Attrs>();
    const extractAttrs = (p: Producto): Attrs => {
      let tipoP = (p.tipo || '').toLowerCase().trim();
      if (tipoP.includes('watch')) tipoP = 'watch';
      const d: any = p.detalle || {};
      const sanitize = (s: string) => s?.toString()?.toLowerCase()?.normalize('NFD')?.replace(/[\u0300-\u036f]/g, '') || '';
      let gamaVal = d?.gama ? String(d.gama).trim() : '';
      let procVal = '';
      for (const key of Object.keys(d || {})) {
        const k = sanitize(key);
        if (k.includes('procesador') || k === 'cpu' || k.includes('chip') || k.startsWith('proc')) { procVal = String(d[key] ?? ''); break; }
      }
      procVal = procVal ? procVal.replace(/\s+/g, ' ').trim() : '';
      let pantallaVal = '';
      const known = ['10.2', '10.9', '11', '12.9', '13', '14', '15', '16'];
      for (const key of Object.keys(d || {})) {
        const k = sanitize(key);
        if (k.includes('tamano') || k.includes('tamanio') || k.includes('tamanopantalla') || k.includes('pantalla') || k.includes('screen') || k.includes('size') || k === 'tam') {
          pantallaVal = String(d[key] ?? '');
          break;
        }
      }
      if (!pantallaVal) {
        const candidates = Object.values(d || {}).filter((v) => typeof v === 'string') as string[];
        const hit = candidates.map(String).find((vs) => known.find((x) => vs.includes(x)));
        if (hit) pantallaVal = known.find((x) => String(hit).includes(x)) || '';
      }
      const m = String(pantallaVal).match(/\d+(?:\.\d+)?/);
      pantallaVal = m ? m[0] : (pantallaVal || '');
      if (!gamaVal && (tipoP === 'iphone' || tipoP === 'watch' || tipoP === 'ipad')) {
        const modelo = d?.modelo ? String(d.modelo).trim() : '';
        if (modelo) gamaVal = modelo;
      }
      return { tipo: tipoP, gama: gamaVal, proc: procVal, pantalla: pantallaVal };
    };
    const getAttrs = (p: Producto): Attrs => {
      const existing = attrsCache.get(p.id);
      if (existing) return existing;
      const parsed = extractAttrs(p);
      attrsCache.set(p.id, parsed);
      return parsed;
    };
    const matchesProductFilters = (p: Producto) => {
      const attrs = getAttrs(p);
      if (tipo && attrs.tipo !== tipo) return false;
      if (gama && attrs.gama !== gama) return false;
      if (procesador && attrs.proc !== procesador) return false;
      if (pantalla && attrs.pantalla !== pantalla) return false;
      return true;
    };

    const ventaQB = this.ventaRepo
      .createQueryBuilder('v')
      .leftJoinAndSelect('v.producto', 'p')
      .leftJoinAndSelect('p.valor', 'val')
      .leftJoinAndSelect('p.detalle', 'det');
    if (dFrom) ventaQB.andWhere('v.fechaVenta >= :fv', { fv: prevRange.from });
    if (dTo) ventaQB.andWhere('v.fechaVenta <= :tv', { tv: to });
    if (tipo && tipo !== 'watch') ventaQB.andWhere('p.tipo = :tipo', { tipo });
    let ventas = await ventaQB.orderBy('v.fechaVenta', 'DESC').addOrderBy('v.id', 'DESC').getMany();

    ventas = ventas.filter((v) => {
      const prod = v.producto as any as Producto | undefined;
      return prod ? matchesProductFilters(prod) : true;
    });

    const sellerTarget = normalizeSeller(vendedor);

    const metricsByKey = new Map<string, CompareMetric>();
    for (const r of ranges) {
      metricsByKey.set(r.key, { income: 0, cost: 0, profit: 0, margin: 0, orders: 0, avgTicket: 0 });
    }

    const topProductMap = new Map<string, { name: string; profit: number }>();

    const inRange = (dateStr: string, start: string, end: string) => {
      const s = String(dateStr || '').slice(0, 10);
      return s >= start && s <= end;
    };

    for (const v of ventas) {
      if (!v.fechaVenta) continue;
      const vDateStr = String(v.fechaVenta).slice(0, 10);
      if (!vDateStr) continue;
      const share = sellerTarget ? shareForSeller(v, sellerTarget) : 1;
      if (!share) continue;
      const cost = (Number(v.producto?.valor?.costoTotal ?? 0) || 0) * share;
      const income = (Number(v.precioVenta ?? 0) || 0) * share;
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

    const finalizeMetric = (m: CompareMetric) => {
      m.income = +m.income.toFixed(2);
      m.cost = +m.cost.toFixed(2);
      m.profit = +(m.income - m.cost).toFixed(2);
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
}
