import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TIPOS_DISPONIBLES } from './entities/cuenta-financiera.entity';
import {
  bucketAntiguedad,
  CuentaCalc,
  diasEntre,
  ESTADOS_REEMBOLSO_CERRADOS,
  finanzasVenta,
  FlujoCalc,
  fromCents,
  margenLiberadoEnPeriodo,
  PagoCalc,
  resumenPago,
  resumenReembolso,
  resumirFlujo,
  toCents,
  VentaCalc,
} from './finanzas-calc';
import { gastoPenCents } from './finanzas.service';

export type FiltrosAnalisis = {
  from: string;
  to: string;
  tipo?: string;
  vendedor?: string;
  cuentaId?: number;
  metodo?: string;
  estadoCobro?: string;
  productoId?: number;
  incluirNoVerificados?: boolean;
};

type VentaRow = {
  id: number;
  productoId: number;
  fechaVenta: string;
  precioVenta: string;
  ganancia: string;
  costoDevuelto?: string;
  precioDevuelto?: string;
  costoPendiente: boolean;
  estadoComercial: string;
  conciliacionHistorica: string;
  vendedor: string | null;
  cantidad: number;
  ventaRapida: boolean;
  tipo: string;
  nombre: string | null;
  codigoInventario: number | null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const hoyLima = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
const money = (cents: number | null | undefined) =>
  cents == null ? null : fromCents(cents);
const mes = (fecha: string) => fecha.slice(0, 7);
const CACHE_TTL_MS = 60_000;

/**
 * Agregaciones financieras del lado del servidor. Cada cifra se calcula una sola vez
 * desde su fuente (ventas, libro de pagos, gastos, movimientos y reembolsos).
 */
@Injectable()
export class FinanzasAnalisisService {
  private cache = new Map<string, { at: number; huella: string; data: any }>();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Huella barata de los datos: cualquier alta, edición o anulación la cambia. */
  /**
   * Huella del contenido de las tablas que alimentan el análisis: cualquier alta,
   * edición o anulación (también desde Gastos o Ventas) la cambia e invalida la caché.
   */
  private async huella(): Promise<string> {
    const [row] = await this.dataSource.query(`
      SELECT
        (SELECT count(*) || ':' || COALESCE(sum(hashtext(t::text)::bigint), 0) FROM venta t) AS v,
        (SELECT count(*) || ':' || COALESCE(sum(hashtext(t::text)::bigint), 0) FROM venta_adelanto t) AS a,
        (SELECT count(*) || ':' || COALESCE(sum(hashtext(t::text)::bigint), 0) FROM venta_pagos t) AS p,
        (SELECT count(*) || ':' || COALESCE(sum(hashtext(t::text)::bigint), 0) FROM pago_liquidaciones t) AS l,
        (SELECT count(*) || ':' || COALESCE(sum(hashtext(t::text)::bigint), 0) FROM gastos t) AS g,
        (SELECT count(*) || ':' || COALESCE(sum(hashtext(t::text)::bigint), 0) FROM movimientos_financieros t) AS m,
        (SELECT count(*) || ':' || COALESCE(sum(hashtext(t::text)::bigint), 0) FROM reembolsos t) AS r,
        (SELECT count(*) || ':' || COALESCE(sum(hashtext(t::text)::bigint), 0) FROM reembolso_eventos t) AS re,
        (SELECT count(*) || ':' || COALESCE(sum(hashtext(concat_ws('|', id, tipo, "stockActual", "stockInicial", "cierreMotivo", "valorId", "detalleId"))::bigint), 0) FROM producto) AS pr,
        (SELECT count(*) || ':' || COALESCE(sum(hashtext(t::text)::bigint), 0) FROM producto_valor t) AS pv,
        (SELECT count(*) || ':' || COALESCE(sum(hashtext(concat_ws('|', id, "productoId", estado, "updatedAt"))::bigint), 0) FROM tracking) AS t,
        (SELECT count(*) || ':' || COALESCE(sum(hashtext(t::text)::bigint), 0) FROM cuentas_financieras t) AS c`);
    return Object.values(row).join('|');
  }

  async analisis(filtros: FiltrosAnalisis) {
    if (
      !DATE_RE.test(filtros.from) ||
      !DATE_RE.test(filtros.to) ||
      filtros.from > filtros.to
    ) {
      throw new BadRequestException('Rango de fechas inválido.');
    }
    const key = JSON.stringify(filtros);
    const huella = await this.huella();
    const cached = this.cache.get(key);
    if (
      cached &&
      cached.huella === huella &&
      Date.now() - cached.at < CACHE_TTL_MS
    )
      return cached.data;
    const data = await this.calcular(filtros);
    if (this.cache.size > 200) this.cache.clear();
    this.cache.set(key, { at: Date.now(), huella, data });
    return data;
  }

  private async cargarBase() {
    const ventas: VentaRow[] = await this.dataSource.query(`
      SELECT v.id, v."productoId", v."fechaVenta"::text AS "fechaVenta", v."precioVenta", v.ganancia, v."costoPendiente", v."costoDevuelto", v."precioDevuelto",
             v."estadoComercial", v."conciliacionHistorica", v.vendedor, v.cantidad, v."ventaRapida",
             p.tipo, p."codigoInventario",
             NULLIF(trim(concat_ws(' ', d.gama, d.procesador, d.tamano, d.modelo, d.almacenamiento, d."descripcionOtro")), '') AS nombre
        FROM venta v
        JOIN producto p ON p.id = v."productoId"
        LEFT JOIN producto_detalle d ON d.id = p."detalleId"`);
    const pagosRows: any[] = await this.dataSource.query(`
      SELECT p.id, p.venta_id AS "ventaId", p.adelanto_id AS "adelantoId", p.monto_pen AS "montoPen", p.fecha_pago::text AS "fechaPago",
             p.requiere_liquidacion AS "requiereLiquidacion", p.comision_estimada AS "comisionEstimada", p.anulado_at AS "anuladoAt",
             p.verificado, p.estado, p.es_adelanto AS "esAdelanto", p.metodo, p.cuenta_receptora_id AS "cuentaId",
             p.fecha_liquidacion_estimada::text AS "fechaLiquidacionEstimada"
        FROM venta_pagos p WHERE p.anulado_at IS NULL`);
    const eventos: any[] = await this.dataSource.query(`
      SELECT l.id, l.pago_id AS "pagoId", l.tipo, l.fecha::text AS fecha, l.monto_bruto AS "montoBruto", l.comision,
             l.monto_neto AS "montoNeto", l.cuenta_id AS "cuentaId"
        FROM pago_liquidaciones l JOIN venta_pagos p ON p.id = l.pago_id WHERE p.anulado_at IS NULL`);
    const cuentas: any[] = await this.dataSource.query(
      `SELECT id, codigo, nombre, tipo, moneda, legacy_codigo AS "legacyCodigo", activo FROM cuentas_financieras ORDER BY tipo, nombre`,
    );
    const costosVinculados: any[] = await this.dataSource.query(`
      SELECT g.id, g.venta_vinculada_id AS "ventaId", g.producto_vinculado_id AS "productoId", g.clasificacion_financiera AS clasificacion,
             g.moneda, g.monto, g.monto_pen AS "montoPen", g.tasa_usd_pen AS tasa, g.fecha::text AS fecha
        FROM gastos g
       WHERE g.clasificacion_financiera IN ('costo_directo', 'comision_venta')
         AND (g.venta_vinculada_id IS NOT NULL OR g.producto_vinculado_id IS NOT NULL)`);
    const reembolsos: any[] = await this.dataSource.query(`
      SELECT r.id, r.producto_id AS "productoId", r.estado, r.moneda, r.tipo_cambio_compra AS "tipoCambioCompra",
             r.costo_original AS "costoOriginal", r.gastos_adicionales AS "gastosAdicionales", r.monto_reclamado AS "montoReclamado",
             r.monto_aprobado AS "montoAprobado", r.fecha_cierre::text AS "fechaCierre", r.fecha_incidencia::text AS "fechaIncidencia",
             COALESCE((SELECT sum(e.monto_pen) FROM reembolso_eventos e WHERE e.reembolso_id = r.id AND e.tipo = 'recibido'), 0) AS "recibidoPen"
        FROM reembolsos r`);
    return {
      ventas,
      pagosRows,
      eventos,
      cuentas,
      costosVinculados,
      reembolsos,
    };
  }

  private async calcular(f: FiltrosAnalisis) {
    const base = await this.cargarBase();
    const incluirNoVerificados = !!f.incluirNoVerificados;
    const hoy = hoyLima();
    const cuentasMap = new Map<
      number,
      CuentaCalc & { nombre: string; legacyCodigo: string | null }
    >();
    for (const c of base.cuentas) {
      cuentasMap.set(Number(c.id), {
        id: Number(c.id),
        codigo: c.codigo,
        tipo: c.tipo,
        nombre: c.nombre,
        legacyCodigo: c.legacyCodigo,
        disponible: TIPOS_DISPONIBLES.includes(c.tipo),
      });
    }
    const cuentaPorLegacy = (codigo?: string | null) => {
      if (!codigo) return null;
      for (const c of cuentasMap.values()) if (c.codigo === codigo) return c.id;
      for (const c of cuentasMap.values())
        if (c.legacyCodigo === codigo && c.disponible) return c.id;
      return null;
    };

    // — Pagos agrupados —
    const eventosPorPago = new Map<number, PagoCalc['eventos']>();
    for (const e of base.eventos) {
      const list = eventosPorPago.get(Number(e.pagoId)) || [];
      list.push({
        tipo: e.tipo,
        fecha: e.fecha,
        brutoCents: toCents(e.montoBruto),
        comisionCents: toCents(e.comision),
        netoCents: toCents(e.montoNeto),
        cuentaId: e.cuentaId == null ? null : Number(e.cuentaId),
      });
      eventosPorPago.set(Number(e.pagoId), list);
    }
    const pagos = base.pagosRows.map((p) => ({
      row: p,
      calc: {
        id: Number(p.id),
        montoCents: toCents(p.montoPen),
        fechaPago: p.fechaPago,
        requiereLiquidacion: !!p.requiereLiquidacion,
        comisionEstimadaCents: toCents(p.comisionEstimada),
        anulado: false,
        verificado: p.verificado !== false,
        disputado: p.estado === 'disputado',
        esAdelanto: !!p.esAdelanto,
        eventos: eventosPorPago.get(Number(p.id)) || [],
      } as PagoCalc,
    }));
    const pagosPorVenta = new Map<number, PagoCalc[]>();
    for (const p of pagos) {
      if (p.row.ventaId == null) continue;
      pagosPorVenta.set(Number(p.row.ventaId), [
        ...(pagosPorVenta.get(Number(p.row.ventaId)) || []),
        p.calc,
      ]);
    }

    // — Costos vinculados (por venta, o por producto con una sola venta) —
    const ventasPorProducto = new Map<number, VentaRow[]>();
    base.ventas.forEach((v) =>
      ventasPorProducto.set(Number(v.productoId), [
        ...(ventasPorProducto.get(Number(v.productoId)) || []),
        v,
      ]),
    );
    const costosPorVenta = new Map<
      number,
      { directos: number; comisiones: number }
    >();
    let costosSinVincular = 0;
    for (const g of base.costosVinculados) {
      let ventaId = g.ventaId ? Number(g.ventaId) : null;
      if (!ventaId) {
        const candidatas = (
          ventasPorProducto.get(Number(g.productoId)) || []
        ).filter((v) => v.estadoComercial !== 'cancelada');
        if (candidatas.length === 1) ventaId = candidatas[0].id;
      }
      const cents = gastoPenCents(g);
      if (!ventaId) {
        costosSinVincular += cents;
        continue;
      }
      const entry = costosPorVenta.get(ventaId) || {
        directos: 0,
        comisiones: 0,
      };
      if (g.clasificacion === 'comision_venta') entry.comisiones += cents;
      else entry.directos += cents;
      costosPorVenta.set(ventaId, entry);
    }

    // — Ventas filtradas y cálculo por venta —
    const coincide = (v: VentaRow) =>
      (!f.tipo || String(v.tipo).toLowerCase() === f.tipo.toLowerCase()) &&
      (!f.vendedor ||
        String(v.vendedor || '')
          .toLowerCase()
          .includes(f.vendedor.toLowerCase())) &&
      (!f.productoId || Number(v.productoId) === f.productoId);
    const ventaCalc = (v: VentaRow): VentaCalc => {
      const costos = costosPorVenta.get(v.id);
      return {
        id: v.id,
        fechaComercial: v.fechaVenta,
        precioCents: toCents(v.precioVenta),
        gananciaCents: v.costoPendiente ? null : toCents(v.ganancia),
        costoDevueltoCents: toCents(v.costoDevuelto),
        precioDevueltoCents: toCents(v.precioDevuelto),
        estadoComercial: v.estadoComercial,
        conciliacionHistorica: v.conciliacionHistorica,
        costosVinculadosCents:
          (costos?.directos || 0) + (costos?.comisiones || 0),
      };
    };
    const nombreVenta = (v: VentaRow) =>
      `${v.nombre || v.tipo}${v.codigoInventario ? ` · MS-${v.codigoInventario}` : ` · #${v.productoId}`}`;

    const filas = base.ventas
      .filter(coincide)
      .map((v) => {
        const pagosVenta = pagosPorVenta.get(v.id) || [];
        const pagosFiltrados = pagosVenta.filter(
          (p) => incluirNoVerificados || p.verificado,
        );
        const calc = ventaCalc(v);
        const actual = finanzasVenta(calc, pagosFiltrados, {
          asOf: f.to,
          incluirNoVerificados,
        });
        const margenPeriodo = margenLiberadoEnPeriodo(
          calc,
          pagosFiltrados,
          f.from,
          f.to,
          { incluirNoVerificados },
        );
        const margenNoVerificado = incluirNoVerificados
          ? 0
          : (margenLiberadoEnPeriodo(calc, pagosVenta, f.from, f.to, {
              incluirNoVerificados: true,
            }) ?? 0) - (margenPeriodo ?? 0);
        return {
          v,
          calc,
          actual,
          margenPeriodo,
          margenNoVerificado,
          pagos: pagosVenta,
        };
      })
      .filter(
        (r) =>
          !f.estadoCobro ||
          r.actual.estadoCobro === f.estadoCobro ||
          r.actual.estadoLiquidacion === f.estadoCobro,
      );

    const enPeriodo = filas.filter(
      (r) =>
        r.v.fechaVenta >= f.from &&
        r.v.fechaVenta <= f.to &&
        r.v.estadoComercial !== 'cancelada',
    );

    // A. Ganancia comercial (por fecha comercial)
    const conCosto = enPeriodo.filter(
      (r) => r.actual.gananciaComercialCents != null,
    );
    const sinCosto = enPeriodo.filter(
      (r) => r.actual.gananciaComercialCents == null,
    );
    const sum = <T>(list: T[], fn: (x: T) => number) =>
      list.reduce((acc, x) => acc + (fn(x) || 0), 0);
    const ingresosComerciales = sum(enPeriodo, (r) => r.calc.precioCents);
    const gananciaComercial = sum(
      conCosto,
      (r) => r.actual.gananciaComercialCents!,
    );
    const gananciaFinalVentas = sum(
      conCosto,
      (r) => r.actual.gananciaFinalCents!,
    );
    const comisionesPeriodo = sum(enPeriodo, (r) => r.actual.comisionesCents);
    const costosDirectosPeriodo = sum(
      enPeriodo,
      (r) => r.actual.costosVinculadosCents,
    );

    // B. Margen cobrado (liberado) dentro del periodo
    const margenCobrado = sum(filas, (r) => r.margenPeriodo || 0);
    const margenNoVerificado = sum(filas, (r) => r.margenNoVerificado || 0);

    // — Gastos del periodo por clasificación —
    const gastosPeriodo: any[] = await this.dataSource.query(
      `
      SELECT g.id, g.fecha::text AS fecha, g.concepto, g.metodo_pago AS "metodoPago", g.tarjeta, g.tarjeta_pago AS "tarjetaPago",
             g.moneda, g.monto, g.monto_pen AS "montoPen", g.tasa_usd_pen AS tasa, g.clasificacion_financiera AS clasificacion,
             g.notas, g.sale_id AS "saleId"
        FROM gastos g
       WHERE g.fecha BETWEEN $1 AND $2`,
      [f.from, f.to],
    );
    const esCobroAutomatico = (g: any) =>
      g.saleId != null || /^__SALE_|^__REFUND__/.test(String(g.notas || ''));
    const porClasificacion: Record<
      string,
      { cantidad: number; monto: number }
    > = {};
    let sinClasificar = { cantidad: 0, monto: 0 };
    for (const g of gastosPeriodo) {
      if (esCobroAutomatico(g) || g.concepto === 'ingreso') continue;
      const cents = gastoPenCents(g);
      if (!g.clasificacion) {
        sinClasificar = {
          cantidad: sinClasificar.cantidad + 1,
          monto: sinClasificar.monto + cents,
        };
        continue;
      }
      const entry = porClasificacion[g.clasificacion] || {
        cantidad: 0,
        monto: 0,
      };
      porClasificacion[g.clasificacion] = {
        cantidad: entry.cantidad + 1,
        monto: entry.monto + cents,
      };
    }
    const reembolsosResumen = base.reembolsos.map((r) => {
      const rate = Number(r.tipoCambioCompra) || null;
      const aPen = (value: unknown) =>
        r.moneda === 'USD'
          ? rate
            ? Math.round(toCents(value) * rate)
            : 0
          : toCents(value);
      return {
        r,
        res: resumenReembolso({
          estado: r.estado,
          costoOriginalCents: toCents(r.costoOriginal),
          gastosAdicionalesCents: toCents(r.gastosAdicionales),
          reclamadoCents: aPen(r.montoReclamado),
          aprobadoCents: r.montoAprobado != null ? aPen(r.montoAprobado) : null,
          recibidoCents: toCents(r.recibidoPen),
        }),
      };
    });
    const perdidasReembolso = sum(
      reembolsosResumen.filter(
        ({ r }) =>
          r.fechaCierre && r.fechaCierre >= f.from && r.fechaCierre <= f.to,
      ),
      ({ res }) => res.irrecuperableCents,
    );
    const operativos = porClasificacion.gasto_operativo?.monto || 0;
    const financieros = porClasificacion.gasto_financiero?.monto || 0;
    const perdidas = (porClasificacion.perdida?.monto || 0) + perdidasReembolso;

    // C. Flujo de caja
    const flujos: FlujoCalc[] = [];
    const ventaPorId = new Map(base.ventas.map((v) => [v.id, v]));
    const pagosNoVerificadosCaja = { cents: 0 };
    for (const { row, calc } of pagos) {
      const venta = row.ventaId ? ventaPorId.get(Number(row.ventaId)) : null;
      if (venta && !coincide(venta)) continue;
      if (f.metodo && row.metodo !== f.metodo) continue;
      const add = (flujo: FlujoCalc) => {
        if (!calc.verificado && !incluirNoVerificados) {
          if (
            flujo.fecha >= f.from &&
            flujo.fecha <= f.to &&
            flujo.cents > 0 &&
            cuentasMap.get(flujo.cuentaId ?? -1)?.disponible !== false
          ) {
            pagosNoVerificadosCaja.cents += flujo.cents;
          }
          return;
        }
        flujos.push({
          ...flujo,
          ventaId: venta?.id ?? null,
          ventaFechaComercial: venta?.fechaVenta ?? null,
          verificado: calc.verificado,
        });
      };
      const cuentaPago = row.cuentaId == null ? null : Number(row.cuentaId);
      if (calc.fechaPago)
        add({
          fecha: calc.fechaPago,
          cuentaId: cuentaPago,
          cents: calc.montoCents,
          categoria: 'cobro_cliente',
          ref: `p${calc.id}`,
        });
      for (const [i, ev] of calc.eventos.entries()) {
        const ref = `p${calc.id}e${i}`;
        if (ev.tipo === 'liquidacion') {
          add({
            fecha: ev.fecha,
            cuentaId: cuentaPago,
            cents: -ev.brutoCents,
            categoria: 'liquidacion',
            ref,
          });
          add({
            fecha: ev.fecha,
            cuentaId: ev.cuentaId ?? null,
            cents: ev.netoCents,
            categoria: 'liquidacion',
            ref,
          });
        } else if (ev.tipo === 'reversion_contracargo') {
          add({
            fecha: ev.fecha,
            cuentaId: ev.cuentaId ?? cuentaPago,
            cents: ev.netoCents,
            categoria: 'contracargo',
            ref,
          });
        } else {
          add({
            fecha: ev.fecha,
            cuentaId: ev.cuentaId ?? cuentaPago,
            cents: -ev.netoCents,
            categoria:
              ev.tipo === 'devolucion' ? 'devolucion_cliente' : 'contracargo',
            ref,
          });
        }
      }
    }
    let pagosTarjeta = 0;
    let comprasCredito = 0;
    for (const g of gastosPeriodo) {
      if (esCobroAutomatico(g)) continue;
      const cents = gastoPenCents(g);
      if (g.metodoPago === 'credito') {
        if (g.concepto !== 'ingreso' && g.concepto !== 'cashback')
          comprasCredito += cents;
        continue; // consumo con tarjeta: es deuda, no salida de caja (sale al pagar la tarjeta)
      }
      const cuentaId = cuentaPorLegacy(g.tarjeta);
      if (g.concepto === 'pago_tarjeta') {
        pagosTarjeta += cents;
        flujos.push({
          fecha: g.fecha,
          cuentaId,
          cents: -cents,
          categoria: 'pago_tarjeta',
          ref: `g${g.id}`,
        });
      } else if (g.concepto === 'ingreso') {
        flujos.push({
          fecha: g.fecha,
          cuentaId,
          cents,
          categoria: 'otros_ingresos',
          ref: `g${g.id}`,
        });
      } else {
        flujos.push({
          fecha: g.fecha,
          cuentaId,
          cents: -cents,
          categoria:
            g.clasificacion === 'costo_inventario' ? 'compra' : 'gasto',
          ref: `g${g.id}`,
        });
      }
    }
    const movimientos: any[] = await this.dataSource.query(
      `
      SELECT id, fecha::text AS fecha, tipo, cuenta_origen_id AS origen, cuenta_destino_id AS destino, monto_pen AS "montoPen"
        FROM movimientos_financieros WHERE anulado_at IS NULL AND fecha BETWEEN $1 AND $2`,
      [f.from, f.to],
    );
    for (const m of movimientos) {
      const cents = toCents(m.montoPen);
      if (m.origen)
        flujos.push({
          fecha: m.fecha,
          cuentaId: Number(m.origen),
          cents: -cents,
          categoria: m.tipo,
          ref: `m${m.id}`,
        });
      if (m.destino)
        flujos.push({
          fecha: m.fecha,
          cuentaId: Number(m.destino),
          cents,
          categoria: m.tipo,
          ref: `m${m.id}`,
        });
    }
    const eventosReembolso: any[] = await this.dataSource.query(
      `
      SELECT e.id, e.fecha::text AS fecha, e.monto_pen AS "montoPen", e.cuenta_id AS "cuentaId"
        FROM reembolso_eventos e WHERE e.tipo = 'recibido' AND e.fecha BETWEEN $1 AND $2`,
      [f.from, f.to],
    );
    let recuperacionesReembolso = 0;
    let reembolsosATarjeta = 0;
    for (const e of eventosReembolso) {
      const cents = toCents(e.montoPen);
      const cuenta = e.cuentaId ? cuentasMap.get(Number(e.cuentaId)) : null;
      if (cuenta?.tipo === 'tarjeta_credito') reembolsosATarjeta += cents;
      else recuperacionesReembolso += cents;
      flujos.push({
        fecha: e.fecha,
        cuentaId: e.cuentaId ? Number(e.cuentaId) : null,
        cents,
        categoria: 'reembolso_recibido',
        ref: `r${e.id}`,
      });
    }
    const flujosPeriodo = flujos
      .filter((x) => x.fecha >= f.from && x.fecha <= f.to)
      .filter((x) => !f.cuentaId || x.cuentaId === f.cuentaId);
    const resumenCaja = resumirFlujo(flujosPeriodo, cuentasMap);
    const cobrosVentasAnteriores = flujosPeriodo.filter(
      (x) =>
        ['cobro_cliente', 'liquidacion'].includes(x.categoria) &&
        x.cents > 0 &&
        cuentasMap.get(x.cuentaId ?? -1)?.disponible !== false &&
        x.ventaFechaComercial &&
        x.ventaFechaComercial < f.from,
    );
    const ventasAnterioresIds = new Set(
      cobrosVentasAnteriores.map((x) => x.ventaId),
    );
    const serie = new Map<string, { entradas: number; salidas: number }>();
    const agrupar = diasEntre(f.from, f.to) > 62 ? mes : (d: string) => d;
    for (const x of flujosPeriodo) {
      if (cuentasMap.get(x.cuentaId ?? -1)?.disponible === false) continue;
      if (x.categoria === 'transferencia') continue;
      const k = agrupar(x.fecha);
      const entry = serie.get(k) || { entradas: 0, salidas: 0 };
      if (x.cents >= 0) entry.entradas += x.cents;
      else entry.salidas -= x.cents;
      serie.set(k, entry);
    }

    // Saldos por cuenta según registros (todo el historial).
    const saldos = await this.saldosPorCuenta(
      cuentasMap,
      cuentaPorLegacy,
      pagos,
      incluirNoVerificados,
    );

    // — Cobros —
    const entregadas = filas.filter(
      (r) => r.v.estadoComercial !== 'cancelada' && r.v.fechaVenta <= f.to,
    );
    const conciliadas = entregadas.filter(
      (r) => r.v.conciliacionHistorica !== 'pendiente',
    );
    const porEstado = (estado: string) =>
      conciliadas.filter((r) => r.actual.estadoCobro === estado);
    const resumenGrupo = (list: typeof filas) => ({
      cantidad: list.length,
      precio: money(sum(list, (r) => r.calc.precioCents)),
      cobrado: money(sum(list, (r) => r.actual.cobradoClienteCents)),
      saldo: money(sum(list, (r) => r.actual.saldoPendienteCents)),
    });
    const porCobrar = sum(conciliadas, (r) => r.actual.saldoPendienteCents);
    const antiguedad: Record<string, { cantidad: number; monto: number }> = {
      '0-30': { cantidad: 0, monto: 0 },
      '31-60': { cantidad: 0, monto: 0 },
      '61-90': { cantidad: 0, monto: 0 },
      '90+': { cantidad: 0, monto: 0 },
    };
    for (const r of conciliadas) {
      if (r.actual.saldoPendienteCents <= 0) continue;
      const b = bucketAntiguedad(
        diasEntre(r.v.fechaVenta, f.to < hoy ? f.to : hoy),
      );
      antiguedad[b] = {
        cantidad: antiguedad[b].cantidad + 1,
        monto: antiguedad[b].monto + r.actual.saldoPendienteCents,
      };
    }
    const porLiquidar = pagos
      .filter(
        ({ row, calc }) =>
          calc.requiereLiquidacion &&
          (calc.verificado || incluirNoVerificados) &&
          (!row.ventaId ||
            (ventaPorId.get(Number(row.ventaId)) &&
              coincide(ventaPorId.get(Number(row.ventaId))!))),
      )
      .map(({ row, calc }) => ({ row, calc, r: resumenPago(calc, f.to) }))
      .filter(({ r }) => r.pendienteLiquidacionCents > 0)
      .map(({ row, calc, r }) => ({
        pagoId: calc.id,
        ventaId: row.ventaId ? Number(row.ventaId) : null,
        adelantoId: row.adelantoId ? Number(row.adelantoId) : null,
        venta:
          row.ventaId && ventaPorId.get(Number(row.ventaId))
            ? nombreVenta(ventaPorId.get(Number(row.ventaId))!)
            : null,
        fechaPago: calc.fechaPago,
        fechaEstimada: row.fechaLiquidacionEstimada,
        metodo: row.metodo,
        cuenta: cuentasMap.get(Number(row.cuentaId))?.nombre || null,
        pendiente: money(r.pendienteLiquidacionCents),
        comisionEstimada: money(r.comisionEstimadaPendienteCents),
        vencida:
          !!row.fechaLiquidacionEstimada && row.fechaLiquidacionEstimada < hoy,
      }))
      .sort((a, b) =>
        String(a.fechaEstimada || '9999').localeCompare(
          String(b.fechaEstimada || '9999'),
        ),
      );
    const retenido = sum(porLiquidar, (x) => toCents(x.pendiente));

    // — Proyección y previsto vs real —
    const proyeccion = [
      ...porLiquidar.map((x) => ({
        fecha: x.fechaEstimada,
        concepto: 'Liquidación esperada',
        ventaId: x.ventaId,
        pagoId: x.pagoId,
        monto: fromCents(toCents(x.pendiente) - toCents(x.comisionEstimada)),
      })),
      ...reembolsosResumen
        .filter(({ res }) => res.porRecuperarCents > 0)
        .map(({ r, res }) => ({
          fecha: null,
          concepto: 'Reembolso por recuperar',
          reembolsoId: r.id,
          productoId: r.productoId,
          monto: fromCents(res.porRecuperarCents),
        })),
    ];
    const previsto = sum(
      pagos.filter(
        ({ row }) =>
          row.fechaLiquidacionEstimada &&
          row.fechaLiquidacionEstimada >= f.from &&
          row.fechaLiquidacionEstimada <= f.to,
      ),
      ({ calc }) => calc.montoCents - calc.comisionEstimadaCents,
    );
    const real = sum(
      pagos.filter(
        ({ row }) =>
          row.fechaLiquidacionEstimada &&
          row.fechaLiquidacionEstimada >= f.from &&
          row.fechaLiquidacionEstimada <= f.to,
      ),
      ({ calc }) =>
        calc.eventos
          .filter((e) => e.tipo === 'liquidacion' && e.fecha <= f.to)
          .reduce((acc, e) => acc + e.netoCents, 0),
    );

    // — Capital inmovilizado —
    const capital = await this.capitalInmovilizado(f, reembolsosResumen);
    const enReclamacion = sum(
      reembolsosResumen,
      ({ res }) => res.capitalEnReclamoCents,
    );
    const reembolsosPorRecuperar = sum(
      reembolsosResumen,
      ({ res }) => res.porRecuperarCents,
    );

    // — Rentabilidad por mes, categoría y producto —
    const agrupa = (keyFn: (r: (typeof filas)[number]) => string) => {
      const map = new Map<
        string,
        {
          clave: string;
          ventas: number;
          ingresos: number;
          ganancia: number;
          gananciaFinal: number;
          comisiones: number;
          costosDirectos: number;
          sinCosto: number;
        }
      >();
      for (const r of enPeriodo) {
        const k = keyFn(r);
        const e = map.get(k) || {
          clave: k,
          ventas: 0,
          ingresos: 0,
          ganancia: 0,
          gananciaFinal: 0,
          comisiones: 0,
          costosDirectos: 0,
          sinCosto: 0,
        };
        e.ventas += 1;
        e.ingresos += r.calc.precioCents;
        if (r.actual.gananciaComercialCents == null) e.sinCosto += 1;
        else {
          e.ganancia += r.actual.gananciaComercialCents;
          e.gananciaFinal += r.actual.gananciaFinalCents!;
        }
        e.comisiones += r.actual.comisionesCents;
        e.costosDirectos += r.actual.costosVinculadosCents;
        map.set(k, e);
      }
      return [...map.values()].map((e) => ({
        ...e,
        ingresos: money(e.ingresos),
        ganancia: money(e.ganancia),
        gananciaFinal: money(e.gananciaFinal),
        comisiones: money(e.comisiones),
        costosDirectos: money(e.costosDirectos),
        margen:
          e.ingresos > 0 && !e.sinCosto
            ? Math.round((e.gananciaFinal / e.ingresos) * 10000) / 100
            : null,
      }));
    };

    const historicosPendientes = filas.filter(
      (r) =>
        r.v.conciliacionHistorica === 'pendiente' &&
        r.v.estadoComercial !== 'cancelada',
    );
    const advertencias: string[] = [];
    if (historicosPendientes.length) {
      advertencias.push(
        `${historicosPendientes.length} ventas anteriores al sistema tienen cobros sin conciliar: sus saldos no se cuentan como por cobrar ni sus cobros como caja hasta confirmarlos.`,
      );
    }
    if (sinCosto.length)
      advertencias.push(
        `${sinCosto.length} ventas del periodo tienen costo desconocido: su utilidad está pendiente y no se suma.`,
      );
    if (sinClasificar.cantidad)
      advertencias.push(
        `${sinClasificar.cantidad} gastos del periodo no están clasificados: no se incluyen en gastos operativos.`,
      );
    if (pagosNoVerificadosCaja.cents)
      advertencias.push(
        `S/ ${fromCents(pagosNoVerificadosCaja.cents).toFixed(2)} de cobros históricos sin verificar quedan fuera del flujo de caja.`,
      );
    if (!saldos.tieneSaldoInicial)
      advertencias.push(
        'Las cuentas no tienen saldo inicial registrado: los saldos son el neto de los movimientos registrados, no el saldo bancario real.',
      );

    const listaVentas = (list: typeof filas, limit = 200) =>
      list.slice(0, limit).map((r) => ({
        ventaId: r.v.id,
        productoId: r.v.productoId,
        nombre: nombreVenta(r.v),
        tipo: r.v.tipo,
        fecha: r.v.fechaVenta,
        precio: money(r.calc.precioCents),
        cobrado: money(r.actual.cobradoClienteCents),
        saldo: money(r.actual.saldoPendienteCents),
        porLiquidar: money(r.actual.pendienteLiquidacionCents),
        ganancia: money(r.actual.gananciaComercialCents),
        gananciaFinal: money(r.actual.gananciaFinalCents),
        margenPeriodo: money(r.margenPeriodo),
        estadoCobro: r.actual.estadoCobro,
        estadoLiquidacion: r.actual.estadoLiquidacion,
        conciliacion: r.v.conciliacionHistorica,
        incierto: r.actual.incierto,
        dias: diasEntre(r.v.fechaVenta, hoy),
      }));

    const gananciaNeta =
      gananciaFinalVentas - operativos - financieros - perdidas;
    return {
      periodo: { from: f.from, to: f.to },
      generadoAt: new Date().toISOString(),
      filtros: f,
      advertencias,
      resumen: {
        ventas: enPeriodo.length,
        ingresosComerciales: money(ingresosComerciales),
        gananciaComercial: money(gananciaComercial),
        ventasSinCosto: sinCosto.length,
        margenCobrado: money(margenCobrado),
        margenCobradoNoVerificado: money(margenNoVerificado),
        cajaEntradas: money(resumenCaja.entradasCents),
        cajaSalidas: money(resumenCaja.salidasCents),
        flujoNeto: money(resumenCaja.netoCents),
        transferenciasInternas: money(resumenCaja.transferenciasInternasCents),
        porCobrar: money(porCobrar),
        retenidoIntermediarios: money(retenido),
        capitalInmovilizado: money(
          capital.inventarioCents +
            capital.transitoCents +
            enReclamacion +
            retenido +
            porCobrar,
        ),
        reembolsosPendientes: money(reembolsosPorRecuperar),
        historicosPendientes: {
          ventas: historicosPendientes.length,
          precio: money(sum(historicosPendientes, (r) => r.calc.precioCents)),
        },
      },
      rentabilidad: {
        porMes: agrupa((r) => mes(r.v.fechaVenta)).sort((a, b) =>
          a.clave.localeCompare(b.clave),
        ),
        porCategoria: agrupa((r) => String(r.v.tipo || 'otro')).sort(
          (a, b) => Number(b.gananciaFinal) - Number(a.gananciaFinal),
        ),
        porProducto: listaVentas(
          [...enPeriodo].sort(
            (a, b) =>
              (b.actual.gananciaFinalCents ?? -Infinity) -
              (a.actual.gananciaFinalCents ?? -Infinity),
          ),
          300,
        ),
        totales: {
          ingresos: money(ingresosComerciales),
          gananciaComercial: money(gananciaComercial),
          comisiones: money(comisionesPeriodo),
          costosDirectos: money(costosDirectosPeriodo),
          gananciaFinalVentas: money(gananciaFinalVentas),
          gastosOperativos: money(operativos),
          gastosFinancieros: money(financieros),
          perdidas: money(perdidas),
          perdidasReembolsos: money(perdidasReembolso),
          gananciaNetaEstimada: sinCosto.length ? null : money(gananciaNeta),
          gananciaNetaParcial: money(gananciaNeta),
          margen:
            ingresosComerciales > 0
              ? Math.round(
                  (gananciaFinalVentas / ingresosComerciales) * 10000,
                ) / 100
              : null,
          costosDirectosSinVincular: money(costosSinVincular),
        },
        gastosPorClasificacion: Object.fromEntries(
          Object.entries(porClasificacion).map(([k, v]) => [
            k,
            { cantidad: v.cantidad, monto: money(v.monto) },
          ]),
        ),
        gastosSinClasificar: {
          cantidad: sinClasificar.cantidad,
          monto: money(sinClasificar.monto),
        },
      },
      cobros: {
        pagadas: resumenGrupo(porEstado('pagado')),
        parciales: resumenGrupo(porEstado('parcialmente_pagado')),
        pendientes: resumenGrupo(porEstado('pendiente')),
        disputadas: resumenGrupo(porEstado('disputado')),
        conciliacionPendiente: resumenGrupo(
          entregadas.filter((r) => r.v.conciliacionHistorica === 'pendiente'),
        ),
        porLiquidar,
        liquidacionesVencidas: porLiquidar.filter((x) => x.vencida).length,
        cobrosVentasAnteriores: {
          monto: money(sum(cobrosVentasAnteriores, (x) => x.cents)),
          ventas: ventasAnterioresIds.size,
          margen: money(
            sum(
              filas.filter((r) => r.v.fechaVenta < f.from),
              (r) => r.margenPeriodo || 0,
            ),
          ),
        },
        antiguedad: Object.fromEntries(
          Object.entries(antiguedad).map(([k, v]) => [
            k,
            { cantidad: v.cantidad, monto: money(v.monto) },
          ]),
        ),
        ventasConSaldo: listaVentas(
          conciliadas
            .filter(
              (r) =>
                r.actual.saldoPendienteCents > 0 ||
                r.actual.pendienteLiquidacionCents > 0,
            )
            .sort((a, b) => a.v.fechaVenta.localeCompare(b.v.fechaVenta)),
        ),
        ventasConCobroEnPeriodo: listaVentas(
          filas
            .filter(
              (r) =>
                (r.margenPeriodo || 0) !== 0 || ventasAnterioresIds.has(r.v.id),
            )
            .sort((a, b) => a.v.fechaVenta.localeCompare(b.v.fechaVenta)),
        ),
      },
      flujo: {
        entradas: money(resumenCaja.entradasCents),
        salidas: money(resumenCaja.salidasCents),
        neto: money(resumenCaja.netoCents),
        transferenciasInternas: money(resumenCaja.transferenciasInternasCents),
        porCategoria: Object.fromEntries(
          Object.entries(resumenCaja.porCategoria).map(([k, v]) => [
            k,
            money(v),
          ]),
        ),
        serie: [...serie.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([fecha, v]) => ({
            fecha,
            entradas: money(v.entradas),
            salidas: money(v.salidas),
            neto: money(v.entradas - v.salidas),
          })),
        pagosTarjeta: money(pagosTarjeta),
        comprasConTarjeta: money(comprasCredito),
        recuperacionesReembolso: money(recuperacionesReembolso),
        reembolsosATarjeta: money(reembolsosATarjeta),
        cobrosSinVerificarExcluidos: money(pagosNoVerificadosCaja.cents),
        saldos: saldos.items,
        proyeccion,
        previstoVsReal: {
          previsto: money(previsto),
          real: money(real),
          diferencia: money(real - previsto),
        },
      },
      capital: {
        inventarioDisponible: {
          monto: money(capital.inventarioCents),
          unidades: capital.inventarioUnidades,
        },
        enTransito: {
          monto: money(capital.transitoCents),
          unidades: capital.transitoUnidades,
        },
        enReclamacion: money(enReclamacion),
        reembolsosPorRecuperar: money(reembolsosPorRecuperar),
        retenidoIntermediarios: money(retenido),
        porCobrar: money(porCobrar),
        productosSinCosto: capital.sinCosto,
        total: money(
          capital.inventarioCents +
            capital.transitoCents +
            enReclamacion +
            retenido +
            porCobrar,
        ),
        nota: 'Los reembolsos por recuperar son parte del capital en reclamación; se muestran aparte solo como referencia.',
        detalle: capital.detalle,
      },
    };
  }

  private async saldosPorCuenta(
    cuentas: Map<
      number,
      CuentaCalc & { nombre: string; legacyCodigo: string | null }
    >,
    cuentaPorLegacy: (c?: string | null) => number | null,
    pagos: Array<{ row: any; calc: PagoCalc }>,
    incluirNoVerificados: boolean,
  ) {
    const saldo = new Map<string, number>();
    const add = (cuentaId: number | null, cents: number) => {
      const k = cuentaId == null ? 'sin_cuenta' : String(cuentaId);
      saldo.set(k, (saldo.get(k) || 0) + cents);
    };
    for (const { row, calc } of pagos) {
      if (!calc.verificado && !incluirNoVerificados) continue;
      const cuentaPago = row.cuentaId == null ? null : Number(row.cuentaId);
      if (calc.fechaPago) add(cuentaPago, calc.montoCents);
      for (const ev of calc.eventos) {
        if (ev.tipo === 'liquidacion') {
          add(cuentaPago, -ev.brutoCents);
          add(ev.cuentaId ?? null, ev.netoCents);
        } else if (ev.tipo === 'reversion_contracargo')
          add(ev.cuentaId ?? cuentaPago, ev.netoCents);
        else add(ev.cuentaId ?? cuentaPago, -ev.netoCents);
      }
    }
    const gastos: any[] = await this.dataSource.query(`
      SELECT g.tarjeta, g.metodo_pago AS "metodoPago", g.concepto,
             sum(COALESCE(g.monto_pen, CASE WHEN g.moneda = 'USD' THEN g.monto * COALESCE(g.tasa_usd_pen, 0) ELSE g.monto END)) AS total
        FROM gastos g
       WHERE g.sale_id IS NULL AND COALESCE(g.notas, '') NOT LIKE '\\_\\_SALE\\_%' AND COALESCE(g.notas, '') NOT LIKE '\\_\\_REFUND\\_\\_%'
         AND g.metodo_pago = 'debito'
       GROUP BY 1, 2, 3`);
    for (const g of gastos) {
      const cents = toCents(g.total);
      add(
        cuentaPorLegacy(g.tarjeta),
        g.concepto === 'ingreso' ? cents : -cents,
      );
    }
    const movs: any[] = await this.dataSource.query(`
      SELECT cuenta_origen_id AS origen, cuenta_destino_id AS destino, tipo, sum(monto_pen) AS total
        FROM movimientos_financieros WHERE anulado_at IS NULL GROUP BY 1, 2, 3`);
    let tieneSaldoInicial = false;
    for (const m of movs) {
      if (m.tipo === 'ajuste') tieneSaldoInicial = true;
      if (m.origen) add(Number(m.origen), -toCents(m.total));
      if (m.destino) add(Number(m.destino), toCents(m.total));
    }
    const reemb: any[] = await this.dataSource.query(
      `SELECT cuenta_id AS "cuentaId", sum(monto_pen) AS total FROM reembolso_eventos WHERE tipo = 'recibido' GROUP BY 1`,
    );
    for (const r of reemb)
      add(r.cuentaId ? Number(r.cuentaId) : null, toCents(r.total));
    const items = [...cuentas.values()].map((c) => ({
      cuentaId: c.id,
      codigo: c.codigo,
      nombre: c.nombre,
      tipo: c.tipo,
      disponible: c.disponible,
      saldo: money(saldo.get(String(c.id)) || 0),
    }));
    if (saldo.get('sin_cuenta')) {
      items.push({
        cuentaId: null as any,
        codigo: 'sin_cuenta',
        nombre: 'Sin cuenta asignada',
        tipo: 'banco',
        disponible: true,
        saldo: money(saldo.get('sin_cuenta')!),
      });
    }
    return { items, tieneSaldoInicial };
  }

  private async capitalInmovilizado(
    f: FiltrosAnalisis,
    reembolsos: Array<{ r: any; res: ReturnType<typeof resumenReembolso> }>,
  ) {
    const enReclamo = new Set(
      reembolsos
        .filter(({ r }) => !ESTADOS_REEMBOLSO_CERRADOS.includes(r.estado))
        .map(({ r }) => Number(r.productoId)),
    );
    const rows: any[] = await this.dataSource.query(
      `
      SELECT p.id, p.tipo, p."stockActual", p."stockInicial", p."codigoInventario",
             NULLIF(trim(concat_ws(' ', d.gama, d.procesador, d.tamano, d.modelo, d."descripcionOtro")), '') AS nombre,
             COALESCE(val."costoTotalProrrateado", val."costoTotal", val."valorSoles" + COALESCE(val."costoEnvioProrrateado", val."costoEnvio", 0)) AS costo,
             (SELECT t.estado FROM tracking t WHERE t."productoId" = p.id ORDER BY t."updatedAt" DESC, t.id DESC LIMIT 1) AS tracking,
             EXISTS (SELECT 1 FROM venta v WHERE v."productoId" = p.id AND v."estadoComercial" <> 'cancelada') AS vendido
        FROM producto p
        LEFT JOIN producto_valor val ON val.id = p."valorId"
        LEFT JOIN producto_detalle d ON d.id = p."detalleId"
       WHERE p."cierreMotivo" IS NULL ${f.tipo ? 'AND lower(p.tipo) = lower($1)' : ''}`,
      f.tipo ? [f.tipo] : [],
    );
    let inventarioCents = 0;
    let transitoCents = 0;
    let inventarioUnidades = 0;
    let transitoUnidades = 0;
    let sinCosto = 0;
    const detalle: Array<{
      productoId: number;
      nombre: string;
      estado: string;
      unidades: number;
      costo: number | null;
    }> = [];
    for (const p of rows) {
      if (enReclamo.has(Number(p.id))) continue;
      const accesorio = String(p.tipo).toLowerCase() === 'accesorios';
      const unidades = accesorio
        ? Math.max(0, Number(p.stockActual || 0))
        : p.vendido
          ? 0
          : 1;
      if (!unidades) continue;
      const costoUnit =
        p.costo == null
          ? null
          : Math.round(
              toCents(p.costo) /
                (accesorio ? Math.max(1, Number(p.stockInicial || 1)) : 1),
            );
      const transito = p.tracking && p.tracking !== 'recogido';
      if (costoUnit == null) sinCosto += 1;
      const cents = (costoUnit || 0) * unidades;
      if (transito) {
        transitoCents += cents;
        transitoUnidades += unidades;
      } else {
        inventarioCents += cents;
        inventarioUnidades += unidades;
      }
      detalle.push({
        productoId: Number(p.id),
        nombre: `${p.nombre || p.tipo}${p.codigoInventario ? ` · MS-${p.codigoInventario}` : ''}`,
        estado: transito ? 'en_transito' : 'disponible',
        unidades,
        costo: costoUnit == null ? null : fromCents(cents),
      });
    }
    detalle.sort((a, b) => Number(b.costo || 0) - Number(a.costo || 0));
    return {
      inventarioCents,
      transitoCents,
      inventarioUnidades,
      transitoUnidades,
      sinCosto,
      detalle: detalle.slice(0, 300),
    };
  }

  /** Listado paginado de ventas con su situación financiera (para navegar desde cada cifra). */
  async listarVentas(
    f: Partial<FiltrosAnalisis> & {
      page?: number;
      pageSize?: number;
      conciliacion?: string;
    },
  ) {
    const from = f.from && DATE_RE.test(f.from) ? f.from : '1900-01-01';
    const to = f.to && DATE_RE.test(f.to) ? f.to : '2999-12-31';
    const data = await this.analisis({ ...f, from, to } as FiltrosAnalisis);
    const all = data.rentabilidad.porProducto as any[];
    const filtradas = f.conciliacion
      ? all.filter((v) => v.conciliacion === f.conciliacion)
      : all;
    const pageSize = Math.min(200, Math.max(1, f.pageSize || 50));
    const page = Math.max(1, f.page || 1);
    return {
      items: filtradas.slice((page - 1) * pageSize, page * pageSize),
      total: filtradas.length,
      page,
      pageSize,
    };
  }
}
