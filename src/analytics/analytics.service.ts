import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Producto } from '../producto/producto.entity';
import { ProductoValor } from '../producto/producto-valor.entity';
import { ProductoDetalle } from '../producto/producto-detalle.entity';
import { Tracking } from '../tracking/tracking.entity';
import { Venta } from '../venta/venta.entity';

type Params = {
  fromCompra?: string;
  toCompra?: string;
  fromVenta?: string;
  toVenta?: string;
  tipo?: string;
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
  const dd = typeof d === 'string' ? new Date(d) : d;
  const y = dd.getFullYear();
  const m = (dd.getMonth() + 1).toString().padStart(2, '0');
  return `${y}-${m}`;
}

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(Producto) private readonly prodRepo: Repository<Producto>,
    @InjectRepository(ProductoValor) private readonly valorRepo: Repository<ProductoValor>,
    @InjectRepository(ProductoDetalle) private readonly detRepo: Repository<ProductoDetalle>,
    @InjectRepository(Tracking) private readonly trackRepo: Repository<Tracking>,
    @InjectRepository(Venta) private readonly ventaRepo: Repository<Venta>,
  ) {}

  async summary(params: Params) {
    const {
      fromCompra,
      toCompra,
      fromVenta,
      toVenta,
      tipo,
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
    if (vendedor) ventaQB.andWhere('v.vendedor = :vendedor', { vendedor });
    const ventas = await ventaQB.orderBy('v.fechaVenta', 'DESC').addOrderBy('v.id', 'DESC').getMany();

    // Build helper maps
    const ventasByProducto = groupBy(ventas, (v) => v.productoId);

    // Filtered products view for inventory calculations
    const productosFiltered = productos.filter((p) => {
      if (tipo && p.tipo !== tipo) return false;
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

    // Active inventory = products without sales record (in filtered set)
    const active = productosFiltered.filter((p) => !(ventasByProducto.get(p.id)?.length));
    const inventoryActiveUnits = active.length;
    const capitalInmovilizado = +(
      active.reduce((s, p) => s + (Number(p.valor?.costoTotal ?? 0) || 0), 0)
    ).toFixed(2);

    // Inventory by type for current active
    const byTypeMap = new Map<string, { unidades: number; capital: number }>();
    for (const p of active) {
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

    // Aging buckets for active
    const today = new Date();
    const aging: any = { bucket15_29: [], bucket30_59: [], bucket60_plus: [] };
    function pushAging(p: Producto, dias: number) {
      const item = {
        productoId: p.id,
        tipo: p.tipo,
        display: productDisplay(p),
        estado: p.estado,
        fechaCompra: p.valor?.fechaCompra,
        costoTotal: p.valor?.costoTotal ?? null,
        diasEnStock: dias,
      };
      if (dias >= aging60) aging.bucket60_plus.push(item);
      else if (dias >= aging30) aging.bucket30_59.push(item);
      else if (dias >= aging15) aging.bucket15_29.push(item);
    }
    for (const p of active) {
      const d = daysBetween(p.valor?.fechaCompra || null, today);
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

    // Logistics: compra -> recepción (per product), recepción -> venta (per sale)
    const compraToRecepDays: number[] = [];
    const recepToVentaDays: number[] = [];
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
    }
    for (const v of ventas) {
      const fp = v.producto?.valor?.fechaCompra;
      // use latest reception date for that product
      const recepDates = (v.producto?.tracking as any[] | undefined)?.map((t) => t.fechaRecepcion).filter(Boolean) || [];
      const fr = recepDates.length ? recepDates.sort()[recepDates.length - 1] : undefined;
      const drv = daysBetween(fr || null, v.fechaVenta);
      if (drv != null) recepToVentaDays.push(drv);
    }

    const logistica = {
      compraARecepcion: { mean: mean(compraToRecepDays), median: median(compraToRecepDays) },
      recepcionAVenta: { mean: mean(recepToVentaDays), median: median(recepToVentaDays) },
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
    const ventasByModelo = groupBy(ventas, (v) => v.producto?.detalle?.modelo || 'N/A');
    const marginByModelo = Array.from(ventasByModelo.entries()).map(([modelo, arr]) => ({
      modelo,
      margenPromedio: mean(arr.map((x) => Number(x.porcentajeGanancia))) ?? 0,
    }));

    // Top/bottom ventas by ganancia
    const sortedByGan = [...ventas].sort((a, b) => Number(b.ganancia) - Number(a.ganancia));
    const topVentas = sortedByGan.slice(0, 10).map((v) => ({
      id: v.id,
      productoId: v.productoId,
      tipo: v.producto?.tipo,
      modelo: v.producto?.detalle?.modelo,
      display: v.producto ? productDisplay(v.producto as any) : undefined,
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
      display: v.producto ? productDisplay(v.producto as any) : undefined,
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

    // Alerts
    const lowMarginVentas = ventas
      .filter((v) => Number(v.porcentajeGanancia) < marginThreshold)
      .map((v) => ({
        id: v.id,
        productoId: v.productoId,
        tipo: v.producto?.tipo,
        modelo: v.producto?.detalle?.modelo,
        display: v.producto ? productDisplay(v.producto as any) : undefined,
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
          transitLongItems.push({ productoId: p.id, tipo: p.tipo, display: productDisplay(p), estado, dias: d, transportista: latest?.transportista, casillero: latest?.casillero });
        }
      }
      if (estado === 'en_eshopex') {
        const d = daysBetween(latest?.fechaRecepcion || null, new Date());
        if (d != null && d > lateDays) {
          transitLongItems.push({ productoId: p.id, tipo: p.tipo, display: productDisplay(p), estado, dias: d, transportista: latest?.transportista, casillero: latest?.casillero });
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
        capitalInmovilizado,
        rotationMedianDaysOverall,
        monthlies,
      },
      inventoryByType,
      aging,
      logistica,
      sales: {
        perMonth: monthlies,
        marginByType,
        marginByModelo,
        topVentas,
        bottomVentas,
        diasHastaVentaPorTipo,
      },
      alerts: {
        lowMarginVentas,
        transitLongItems,
      },
    };
  }
}
