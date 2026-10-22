/**
 * Cálculos financieros puros (sin base de datos). Todo se hace en céntimos enteros
 * para no acumular errores de punto flotante.
 *
 * Tres indicadores independientes que nunca se suman entre sí:
 *  A. Ganancia comercial: se reconoce en la fecha comercial (entrega) de la venta.
 *  B. Margen liberado: utilidad final × (dinero neto disponible / neto esperado), acotado a [0, 1].
 *  C. Flujo de caja: movimientos reales de dinero en cuentas propias disponibles.
 */

export const toCents = (value: unknown): number => {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
};
export const fromCents = (cents: number): number => Math.round(cents) / 100;

/** Convierte un importe a céntimos de sol, con tipo de cambio obligatorio si es USD. */
export function penCents(
  amount: unknown,
  currency: 'PEN' | 'USD' | string | null | undefined,
  rate?: unknown,
): number {
  const cents = toCents(amount);
  if (!currency || currency === 'PEN') return cents;
  const fx = Number(rate);
  if (!Number.isFinite(fx) || fx <= 0)
    throw new Error('Tipo de cambio requerido para importes en USD.');
  return Math.round(cents * fx);
}

/** Redondeo half-up de a*b/c con enteros (c > 0). Soporta valores negativos de a. */
export function mulDiv(a: number, b: number, c: number): number {
  if (c === 0) return 0;
  const sign = Math.sign(a) * Math.sign(b) * Math.sign(c) || 1;
  const value = (Math.abs(a) * Math.abs(b)) / Math.abs(c);
  return sign * Math.round(value);
}

export type EventoPagoCalc = {
  tipo: 'liquidacion' | 'devolucion' | 'contracargo' | 'reversion_contracargo';
  fecha: string;
  brutoCents: number;
  comisionCents: number;
  netoCents: number;
  /** null cuando lo descuenta la pasarela antes de liquidar (no sale de una cuenta propia). */
  cuentaId?: number | null;
};

export type PagoCalc = {
  id: number;
  montoCents: number; // en soles
  fechaPago: string | null;
  requiereLiquidacion: boolean;
  comisionEstimadaCents: number;
  anulado: boolean;
  verificado: boolean;
  disputado?: boolean;
  esAdelanto?: boolean;
  eventos: EventoPagoCalc[];
};

export type VentaCalc = {
  id: number;
  fechaComercial: string; // YYYY-MM-DD
  precioCents: number;
  /** null cuando el costo es desconocido (utilidad pendiente de calcular). */
  gananciaCents: number | null;
  estadoComercial: 'reservada' | 'entregada' | 'cancelada' | string;
  conciliacionHistorica?: string;
  /** Gastos vinculados (costos directos y comisiones registrados en Gastos). */
  costosVinculadosCents?: number;
  costoDevueltoCents?: number;
  precioDevueltoCents?: number;
};

const upTo = (fecha: string | null | undefined, asOf?: string | null) =>
  !asOf ? true : fecha != null && fecha <= asOf;

export type PagoResumen = {
  liquidadoBrutoCents: number;
  comisionCents: number;
  comisionEstimadaPendienteCents: number;
  devueltoCents: number;
  contracargoCents: number;
  reversionCents: number;
  pendienteLiquidacionCents: number;
  /** Dinero neto que ya llegó a una cuenta propia (a la fecha asOf). */
  disponibleCents: number;
};

export function resumenPago(pago: PagoCalc, asOf?: string | null): PagoResumen {
  const empty: PagoResumen = {
    liquidadoBrutoCents: 0,
    comisionCents: 0,
    comisionEstimadaPendienteCents: 0,
    devueltoCents: 0,
    contracargoCents: 0,
    reversionCents: 0,
    pendienteLiquidacionCents: 0,
    disponibleCents: 0,
  };
  // A una fecha anterior al pago (o sin fecha conocida), el pago todavía no existe.
  // Un pago confirmado sin fecha (conciliación histórica) cuenta como pagado a cualquier
  // fecha, pero no como dinero disponible en un mes concreto.
  const sinFecha = pago.fechaPago == null;
  if (pago.anulado || (!sinFecha && !upTo(pago.fechaPago, asOf))) return empty;
  const r = { ...empty };
  let disponible = 0;
  if (!pago.requiereLiquidacion && (!sinFecha || !asOf))
    disponible += pago.montoCents;
  for (const ev of pago.eventos) {
    if (!upTo(ev.fecha, asOf)) continue;
    if (ev.tipo === 'liquidacion') {
      r.liquidadoBrutoCents += ev.brutoCents;
      r.comisionCents += ev.comisionCents;
      disponible += ev.netoCents;
    } else if (ev.tipo === 'devolucion') {
      r.devueltoCents += ev.brutoCents;
      if (ev.cuentaId != null) disponible -= ev.netoCents;
    } else if (ev.tipo === 'contracargo') {
      r.contracargoCents += ev.brutoCents;
      if (ev.cuentaId != null) disponible -= ev.netoCents;
    } else if (ev.tipo === 'reversion_contracargo') {
      r.reversionCents += ev.brutoCents;
      if (ev.cuentaId != null) disponible += ev.netoCents;
    }
  }
  if (pago.requiereLiquidacion) {
    r.pendienteLiquidacionCents = Math.max(
      0,
      pago.montoCents -
        r.liquidadoBrutoCents -
        r.devueltoCents -
        r.contracargoCents +
        r.reversionCents,
    );
    if (pago.montoCents > 0 && r.pendienteLiquidacionCents > 0) {
      r.comisionEstimadaPendienteCents = mulDiv(
        pago.comisionEstimadaCents,
        r.pendienteLiquidacionCents,
        pago.montoCents,
      );
    }
  }
  r.disponibleCents = disponible;
  return r;
}

export type EstadoCobro =
  | 'pendiente'
  | 'parcialmente_pagado'
  | 'pagado'
  | 'devuelto'
  | 'disputado'
  | 'conciliacion_pendiente';
export type EstadoLiquidacion =
  | 'no_requiere'
  | 'pendiente_liquidacion'
  | 'parcialmente_liquidado'
  | 'liquidado';

export type VentaFinanzas = {
  precioCents: number;
  cobradoClienteCents: number; // pagado por el cliente, neto de devoluciones y contracargos
  saldoPendienteCents: number; // cuenta por cobrar al cliente
  sobrepagoCents: number;
  pendienteLiquidacionCents: number; // pagado por el cliente pero aún retenido
  disponibleCents: number; // dinero neto ya recibido en cuentas propias
  comisionesCents: number; // reales + estimadas pendientes
  comisionesRealesCents: number;
  devolucionesCents: number;
  contracargosNetosCents: number;
  costosVinculadosCents: number;
  gananciaComercialCents: number | null;
  gananciaFinalCents: number | null;
  netoEsperadoCents: number;
  margenLiberadoCents: number | null;
  margenPendienteCents: number | null;
  porcentajeLiberado: number; // 0..1
  estadoCobro: EstadoCobro;
  estadoLiquidacion: EstadoLiquidacion;
  /** Hay pagos históricos sin verificar: las cifras de cobro no son exactas. */
  incierto: boolean;
};

/**
 * Situación financiera de una venta. Los importes de comisión, devolución y costos
 * vinculados se calculan con toda la información conocida; la disponibilidad del
 * dinero (y por tanto el margen liberado) se mide a la fecha asOf.
 */
export function finanzasVenta(
  venta: VentaCalc,
  pagos: PagoCalc[],
  options: { asOf?: string | null; incluirNoVerificados?: boolean } = {},
): VentaFinanzas {
  const incluirNoVerificados = options.incluirNoVerificados ?? true;
  const activos = pagos.filter(
    (p) => !p.anulado && (incluirNoVerificados || p.verificado),
  );
  const totales = activos.map((p) => resumenPago(p));
  const sum = (fn: (r: PagoResumen, p: PagoCalc) => number) =>
    totales.reduce((acc, r, i) => acc + fn(r, activos[i]), 0);

  const cancelada = venta.estadoComercial === 'cancelada';
  // Resultado económico: con todo lo conocido (comisiones, devoluciones, contracargos).
  const devoluciones = sum((r) => r.devueltoCents);
  const contracargosNetos = sum((r) => r.contracargoCents - r.reversionCents);
  const comisionesReales = sum((r) => r.comisionCents);
  const comisionesEstimadas = sum((r) => r.comisionEstimadaPendienteCents);
  const comisiones = comisionesReales + comisionesEstimadas;
  const costosVinculados = venta.costosVinculadosCents || 0;

  // Situación de cobro: solo lo ocurrido hasta asOf.
  const pagadosAsOf = activos.filter(
    (p) => p.fechaPago == null || upTo(p.fechaPago, options.asOf),
  );
  const resumenAsOf = activos.map((p) => resumenPago(p, options.asOf));
  const sumAsOf = (fn: (r: PagoResumen) => number) =>
    resumenAsOf.reduce((acc, r) => acc + fn(r), 0);
  const pagadoBruto = pagadosAsOf.reduce((acc, p) => acc + p.montoCents, 0);
  const cobradoCliente =
    pagadoBruto -
    sumAsOf((r) => r.devueltoCents) -
    sumAsOf((r) => r.contracargoCents - r.reversionCents);
  const devolucionesAsOf = sumAsOf((r) => r.devueltoCents);
  const precio = cancelada ? 0 : venta.precioCents;
  // Una devolución aceptada reduce la obligación del cliente: no vuelve a cobrarla.
  const saldoPendiente = Math.max(0, precio - cobradoCliente - Math.max(venta.precioDevueltoCents || 0, sumAsOf((r) => r.devueltoCents)));
  const sobrepago = Math.max(0, cobradoCliente - precio);
  const pendienteLiquidacion = sumAsOf((r) => r.pendienteLiquidacionCents);
  const disponibleAsOf = sumAsOf((r) => r.disponibleCents);

  const gananciaComercial = cancelada ? 0 : venta.gananciaCents;
  const gananciaFinal =
    gananciaComercial == null
      ? null
      : gananciaComercial + (cancelada ? 0 : venta.costoDevueltoCents || 0) -
        comisiones -
        costosVinculados -
        (cancelada ? 0 : Math.max(devoluciones, venta.precioDevueltoCents || 0) + contracargosNetos);

  const netoEsperado = Math.max(
    0,
    precio - comisiones - Math.max(devoluciones, venta.precioDevueltoCents || 0) - contracargosNetos,
  );
  let porcentaje = 0;
  const reconocida = !options.asOf || options.asOf >= venta.fechaComercial;
  if (netoEsperado > 0 && reconocida && !cancelada) {
    porcentaje = Math.min(1, Math.max(0, disponibleAsOf / netoEsperado));
  } else if (netoEsperado === 0 && reconocida && !cancelada && precio > 0) {
    // Todo el precio se perdió en comisiones o devoluciones: el resultado queda liberado.
    porcentaje = 1;
  }
  const margenLiberado =
    gananciaFinal == null || !reconocida || cancelada
      ? gananciaFinal == null
        ? null
        : 0
      : netoEsperado > 0
        ? mulDiv(
            gananciaFinal,
            Math.min(Math.max(disponibleAsOf, 0), netoEsperado),
            netoEsperado,
          )
        : precio > 0
          ? gananciaFinal
          : 0;

  const requiere = pagadosAsOf.filter((p) => p.requiereLiquidacion);
  const requiereTotal = requiere.reduce((acc, p) => acc + p.montoCents, 0);
  let estadoLiquidacion: EstadoLiquidacion = 'no_requiere';
  if (requiereTotal > 0) {
    if (pendienteLiquidacion <= 0) estadoLiquidacion = 'liquidado';
    else if (pendienteLiquidacion >= requiereTotal)
      estadoLiquidacion = 'pendiente_liquidacion';
    else estadoLiquidacion = 'parcialmente_liquidado';
  }

  const incierto =
    pagos.some((p) => !p.anulado && !p.verificado) ||
    venta.conciliacionHistorica === 'pendiente';
  let estadoCobro: EstadoCobro;
  const abiertoEnDisputa =
    pagadosAsOf.some((p) => p.disputado) ||
    resumenAsOf.some((r) => r.contracargoCents > r.reversionCents);
  if (abiertoEnDisputa) estadoCobro = 'disputado';
  else if (cobradoCliente <= 0 && devolucionesAsOf > 0)
    estadoCobro = 'devuelto';
  else if (
    venta.conciliacionHistorica === 'pendiente' &&
    !activos.some((p) => p.verificado)
  )
    estadoCobro = 'conciliacion_pendiente';
  else if (cancelada)
    estadoCobro = cobradoCliente > 0 ? 'parcialmente_pagado' : 'devuelto';
  else if (cobradoCliente <= 0) estadoCobro = 'pendiente';
  else if (cobradoCliente < precio) estadoCobro = 'parcialmente_pagado';
  else estadoCobro = 'pagado';

  return {
    precioCents: precio,
    cobradoClienteCents: cobradoCliente,
    saldoPendienteCents: saldoPendiente,
    sobrepagoCents: sobrepago,
    pendienteLiquidacionCents: pendienteLiquidacion,
    disponibleCents: disponibleAsOf,
    comisionesCents: comisiones,
    comisionesRealesCents: comisionesReales,
    devolucionesCents: devoluciones,
    contracargosNetosCents: contracargosNetos,
    costosVinculadosCents: costosVinculados,
    gananciaComercialCents: gananciaComercial,
    gananciaFinalCents: gananciaFinal,
    netoEsperadoCents: netoEsperado,
    margenLiberadoCents: margenLiberado,
    margenPendienteCents:
      gananciaFinal == null || margenLiberado == null
        ? null
        : gananciaFinal - margenLiberado,
    porcentajeLiberado: porcentaje,
    estadoCobro,
    estadoLiquidacion,
    incierto,
  };
}

const dayBefore = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/** Margen liberado dentro de [from, to] = acumulado(to) - acumulado(from - 1 día). */
export function margenLiberadoEnPeriodo(
  venta: VentaCalc,
  pagos: PagoCalc[],
  from: string,
  to: string,
  options: { incluirNoVerificados?: boolean } = {},
): number | null {
  const fin = finanzasVenta(venta, pagos, {
    ...options,
    asOf: to,
  }).margenLiberadoCents;
  const ini = finanzasVenta(venta, pagos, {
    ...options,
    asOf: dayBefore(from),
  }).margenLiberadoCents;
  if (fin == null || ini == null) return null;
  return fin - ini;
}

/** Fechas (YYYY-MM-DD) en las que cambia el dinero disponible de una venta. */
export function fechasDeCobro(pagos: PagoCalc[]): string[] {
  const set = new Set<string>();
  for (const p of pagos) {
    if (p.anulado) continue;
    if (!p.requiereLiquidacion && p.fechaPago) set.add(p.fechaPago);
    for (const ev of p.eventos) set.add(ev.fecha);
  }
  return [...set].sort();
}

// ————————————————————————— Flujo de caja —————————————————————————

export type CuentaCalc = {
  id: number;
  codigo: string;
  tipo: string;
  disponible: boolean;
};

export type FlujoCalc = {
  fecha: string;
  cuentaId: number | null; // null = sin cuenta asignada (se trata como disponible)
  cents: number; // + entra, - sale
  categoria:
    | 'cobro_cliente'
    | 'liquidacion'
    | 'devolucion_cliente'
    | 'contracargo'
    | 'reembolso_recibido'
    | 'compra'
    | 'gasto'
    | 'pago_tarjeta'
    | 'otros_ingresos'
    | 'transferencia'
    | 'ajuste';
  /** Identificador de la operación; los dos tramos de una transferencia comparten el mismo. */
  ref: string;
  ventaId?: number | null;
  /** Venta comercialmente reconocida antes del periodo consultado. */
  ventaFechaComercial?: string | null;
  verificado?: boolean;
};

export type ResumenFlujo = {
  entradasCents: number;
  salidasCents: number;
  netoCents: number;
  transferenciasInternasCents: number;
  porCategoria: Record<string, number>;
  porCuenta: Record<string, number>;
};

/**
 * Consolida los flujos sobre cuentas propias disponibles. Las transferencias entre
 * dos cuentas disponibles no son entradas ni salidas: solo se informan aparte.
 */
export function resumirFlujo(
  flujos: FlujoCalc[],
  cuentas: Map<number, CuentaCalc>,
): ResumenFlujo {
  const esDisponible = (id: number | null) =>
    id == null || cuentas.get(id)?.disponible !== false;
  const porRef = new Map<string, FlujoCalc[]>();
  for (const f of flujos) {
    if (f.categoria !== 'transferencia') continue;
    porRef.set(f.ref, [...(porRef.get(f.ref) || []), f]);
  }
  const interno = (f: FlujoCalc) =>
    f.categoria === 'transferencia' &&
    (porRef.get(f.ref) || []).length === 2 &&
    (porRef.get(f.ref) || []).every((leg) => esDisponible(leg.cuentaId));

  const res: ResumenFlujo = {
    entradasCents: 0,
    salidasCents: 0,
    netoCents: 0,
    transferenciasInternasCents: 0,
    porCategoria: {},
    porCuenta: {},
  };
  for (const f of flujos) {
    const key = f.cuentaId == null ? 'sin_cuenta' : String(f.cuentaId);
    res.porCuenta[key] = (res.porCuenta[key] || 0) + f.cents;
    if (!esDisponible(f.cuentaId)) continue;
    if (interno(f)) {
      if (f.cents > 0) res.transferenciasInternasCents += f.cents;
      continue;
    }
    if (f.cents >= 0) res.entradasCents += f.cents;
    else res.salidasCents += -f.cents;
    res.porCategoria[f.categoria] =
      (res.porCategoria[f.categoria] || 0) + f.cents;
  }
  res.netoCents = res.entradasCents - res.salidasCents;
  return res;
}

// ————————————————————————— Reembolsos —————————————————————————

export type ReembolsoCalc = {
  estado: string;
  costoOriginalCents: number; // en soles
  gastosAdicionalesCents: number; // en soles
  reclamadoCents: number; // en soles
  aprobadoCents: number | null; // en soles
  recibidoCents: number; // en soles, suma de eventos recibidos
};

export const ESTADOS_REEMBOLSO_CERRADOS = [
  'recibido',
  'rechazado',
  'perdida_definitiva',
];

/**
 * Un reembolso recupera capital: nunca es venta ni ganancia comercial.
 * La pérdida solo se reconoce al cerrar el caso (o si se recibe más de lo invertido, una recuperación extra).
 */
export function resumenReembolso(r: ReembolsoCalc) {
  const invertido = r.costoOriginalCents + r.gastosAdicionalesCents;
  const cerrado = ESTADOS_REEMBOLSO_CERRADOS.includes(r.estado);
  const esperado =
    r.estado === 'rechazado' || r.estado === 'perdida_definitiva'
      ? r.recibidoCents
      : (r.aprobadoCents ?? r.reclamadoCents);
  const porRecuperar = cerrado ? 0 : Math.max(0, esperado - r.recibidoCents);
  const capitalEnReclamo = cerrado
    ? 0
    : Math.max(0, invertido - r.recibidoCents);
  const resultado = cerrado ? r.recibidoCents - invertido : null; // negativo = pérdida
  return {
    invertidoCents: invertido,
    recibidoCents: r.recibidoCents,
    porRecuperarCents: porRecuperar,
    capitalEnReclamoCents: capitalEnReclamo,
    irrecuperableCents: resultado != null && resultado < 0 ? -resultado : 0,
    resultadoCierreCents: resultado,
    cerrado,
  };
}

// ————————————————————————— Ventas rápidas —————————————————————————

export function resumenVentaRapida(
  items: Array<{
    cantidad: number;
    precioUnitario: number;
    costoUnitario?: number | null;
  }>,
) {
  let ingreso = 0;
  let costo = 0;
  let costoConocido = true;
  for (const item of items) {
    const qty = Math.max(0, Math.trunc(Number(item.cantidad) || 0));
    ingreso += toCents(item.precioUnitario) * qty;
    if (item.costoUnitario == null || item.costoUnitario === ('' as any))
      costoConocido = false;
    else costo += toCents(item.costoUnitario) * qty;
  }
  const ganancia = costoConocido ? ingreso - costo : null;
  return {
    ingresoCents: ingreso,
    costoCents: costoConocido ? costo : null,
    gananciaCents: ganancia,
    margen:
      ganancia != null && ingreso > 0
        ? Math.round((ganancia / ingreso) * 10000) / 100
        : null,
  };
}

// ————————————————————————— Utilidades de fechas —————————————————————————

export function diasEntre(desde: string, hasta: string): number {
  const a = Date.parse(`${desde}T00:00:00Z`);
  const b = Date.parse(`${hasta}T00:00:00Z`);
  return Math.floor((b - a) / 86400000);
}

export function bucketAntiguedad(
  dias: number,
): '0-30' | '31-60' | '61-90' | '90+' {
  if (dias <= 30) return '0-30';
  if (dias <= 60) return '31-60';
  if (dias <= 90) return '61-90';
  return '90+';
}
