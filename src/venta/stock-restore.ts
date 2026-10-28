import { Venta } from './venta.entity';
import { VentaDevolucion } from './venta-devolucion.entity';

/**
 * Unidades de cada lote que una venta aún tiene fuera del stock: las de su distribución
 * original menos las que ya volvieron (a cualquier destino) por devoluciones previas.
 */
export function unidadesPorReponer(
  venta: Pick<Venta, 'productoId' | 'cantidad' | 'distribucionStock'>,
  devoluciones: Array<Pick<VentaDevolucion, 'lotes'>>,
): Array<{ productoId: number; cantidad: number }> {
  const distribucion = Array.isArray(venta.distribucionStock) && venta.distribucionStock.some((row) => Number(row?.productoId) && Number(row?.cantidad) > 0)
    ? venta.distribucionStock.filter((row) => Number(row?.productoId) && Number(row?.cantidad) > 0)
    : [{ productoId: venta.productoId, cantidad: Number(venta.cantidad || 1) }];
  const devueltos = new Map<number, number>();
  devoluciones.flatMap((row) => row.lotes || [])
    .forEach((row) => devueltos.set(Number(row.productoId), (devueltos.get(Number(row.productoId)) || 0) + Number(row.cantidad)));
  const resultado: Array<{ productoId: number; cantidad: number }> = [];
  for (const part of distribucion) {
    const productoId = Number(part.productoId);
    const yaDevueltas = Math.min(Number(part.cantidad), devueltos.get(productoId) || 0);
    devueltos.set(productoId, (devueltos.get(productoId) || 0) - yaDevueltas);
    const cantidad = Number(part.cantidad) - yaDevueltas;
    if (cantidad > 0) resultado.push({ productoId, cantidad });
  }
  return resultado;
}
