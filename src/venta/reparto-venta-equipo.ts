import { fromCents, toCents } from '../finanzas/finanzas-calc';
import type { Venta } from './venta.entity';

function repartirCentimos(total: number, pesos: bigint[]) {
  const suma = pesos.reduce((valor, peso) => valor + peso, 0n);
  if (!suma) return pesos.map((_, indice) => indice === 0 ? total : 0);
  const importe = BigInt(Math.abs(total));
  const partes = pesos.map((peso, indice) => {
    const proporcional = importe * peso;
    return { indice, centimos: Number(proporcional / suma), resto: proporcional % suma };
  });
  const faltan = Math.abs(total) - partes.reduce((valor, parte) => valor + parte.centimos, 0);
  const orden = [...partes].sort((a, b) => a.resto === b.resto ? a.indice - b.indice : a.resto > b.resto ? -1 : 1);
  orden.slice(0, faltan).forEach((parte) => { parte.centimos++; });
  return partes.map((parte) => parte.centimos * Math.sign(total));
}

/** Deriva el reparto del precio vigente y los costos fijados al registrar la venta. */
export function desgloseVentaConAccesorios(
  venta: Pick<Venta, 'productoId' | 'precioVenta' | 'distribucionStock' | 'costoPendiente' | 'precioDevuelto' | 'costoDevuelto'>,
) {
  const partes = venta.distribucionStock;
  if (!Array.isArray(partes) || !partes.some((parte) => parte.nombre && parte.productoId !== venta.productoId)) return [];
  const costos = partes.map((parte) => parte.costoUnitario == null ? null : Number(parte.costoUnitario) * parte.cantidad);
  const costoPendiente = venta.costoPendiente || costos.some((costo) => costo == null || !Number.isFinite(costo));
  const bruto = toCents(venta.precioVenta) - toCents(venta.precioDevuelto);
  // Conserva la precisión del costo por lote aun cuando su costo unitario tenga fracciones de céntimo.
  const pesos = costoPendiente ? [] : costos.map((costo) => BigInt(Math.round(Math.max(0, costo ?? 0) * 1_000_000)));
  const costosTotales = costos.reduce<number>((total, costo) => total + (costo ?? 0), 0);
  const ingresos = costoPendiente ? [] : repartirCentimos(bruto, pesos);
  const costoNeto = costoPendiente ? [] : repartirCentimos(toCents(costosTotales) - toCents(venta.costoDevuelto), pesos);
  return partes.map((parte, i) => ({
    productoId: parte.productoId,
    nombre: parte.nombre,
    cantidad: parte.cantidad,
    ingreso: costoPendiente ? null : fromCents(ingresos[i]),
    costo: costoPendiente ? (costos[i] == null ? null : fromCents(toCents(costos[i]))) : fromCents(costoNeto[i]),
    ganancia: costoPendiente ? null : fromCents(ingresos[i] - costoNeto[i]),
  }));
}

export function ventaConDesglose<T extends Venta>(venta: T) {
  const desgloseAccesorios = desgloseVentaConAccesorios(venta);
  return desgloseAccesorios.length ? { ...venta, desgloseAccesorios } : venta;
}
