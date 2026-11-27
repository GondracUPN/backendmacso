import { BadRequestException, ConflictException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { accessoryUnitCost } from '../producto/accessory-cost';
import { Producto } from '../producto/producto.entity';
import { Venta } from '../venta/venta.entity';
import { calculateProfitPercentage } from '../venta/venta-profit.utils';
import { AccesorioIncluidoStock, ProductoAccesoriosStock } from './producto-accesorios-stock.entity';

export const MAX_ACCESORIOS_INCLUIDOS = 30;

export type SeleccionAccesoriosStock = {
  accesoriosStockIds?: number[];
  accesoriosStockRevision?: number;
};

export function validarSeleccionAccesoriosStock(seleccion: SeleccionAccesoriosStock) {
  const { accesoriosStockIds: ids, accesoriosStockRevision: revision } = seleccion;
  if (ids === undefined && revision === undefined) return;
  if (!Array.isArray(ids) || ids.length > MAX_ACCESORIOS_INCLUIDOS
    || ids.some((id) => !Number.isSafeInteger(id) || id < 1 || id > 2147483647)
    || new Set(ids).size !== ids.length || !Number.isSafeInteger(revision) || revision! < 0) {
    throw new BadRequestException('Selección de accesorios de stock inválida.');
  }
}

export function coincideSeleccionVendida(venta: Venta, seleccion: number[]) {
  const vendidos = (venta.distribucionStock || []).filter((part) => part.nombre);
  return vendidos.length === seleccion.length && vendidos.every((part) => seleccion.includes(part.productoId));
}

export async function leerAccesoriosStock(manager: EntityManager, productoId: number) {
  const [stock] = await manager.query(
    'SELECT accesorios, revision FROM producto_accesorios_stock WHERE "productoId" = $1',
    [productoId],
  ) as Array<Pick<ProductoAccesoriosStock, 'accesorios' | 'revision'>>;
  return stock ?? { accesorios: [], revision: 0 };
}

export function nombreAccesorio(lote: Producto) {
  return [lote.referencia?.modelo || lote.detalle?.modelo, lote.referencia?.variante || lote.detalle?.descripcionOtro]
    .filter(Boolean).join(' ').trim() || `Accesorio ACC-${lote.codigoInventario || lote.id}`;
}

export function accesorioParaCatalogo(item: AccesorioIncluidoStock, lote?: Producto) {
  const costo = lote ? accessoryUnitCost(lote) : null;
  return { ...item, costoCompraUnitario: costo == null ? null : +costo.toFixed(2) };
}

export async function lotesDeAccesoriosStock(manager: EntityManager, items: AccesorioIncluidoStock[]) {
  const ids = [...new Set(items.map((item) => item.productoId))];
  const lotes = ids.length ? await manager.getRepository(Producto).findBy({ id: In(ids) }) : [];
  return new Map(lotes.map((lote) => [lote.id, lote]));
}

export async function devolverAccesoriosStock(manager: EntityManager, items: AccesorioIncluidoStock[]) {
  const repo = manager.getRepository(Producto);
  for (const { productoId } of [...items].sort((a, b) => a.productoId - b.productoId)) {
    await repo.increment({ id: productoId }, 'stockActual', 1);
  }
}

/** El stock libre ya bajó al reservar. La venta solo libera los accesorios excluidos. */
export async function consumirAccesoriosStock(
  manager: EntityManager, productoId: number, seleccion: SeleccionAccesoriosStock,
) {
  validarSeleccionAccesoriosStock(seleccion);
  const stock = await leerAccesoriosStock(manager, productoId);
  const ids = seleccion.accesoriosStockIds;
  if (ids && (seleccion.accesoriosStockRevision !== stock.revision
    || ids.some((id) => !stock.accesorios.some((item) => item.productoId === id)))) {
    throw new ConflictException('Los accesorios incluidos cambiaron. Actualiza el inventario y vuelve a revisar la venta.');
  }
  if (!stock.accesorios.length) return [];
  const apartados = stock.accesorios.filter((item) => !ids || ids.includes(item.productoId));
  const excluidos = stock.accesorios.filter((item) => ids && !ids.includes(item.productoId));
  const lotes = apartados.length ? await manager.getRepository(Producto).findBy({
    id: In(apartados.map((item) => item.productoId)),
  }) : [];
  const partes = apartados.map((item) => {
    const lote = lotes.find((part) => part.id === item.productoId);
    if (!lote) throw new ConflictException('No se encontró un lote de los accesorios incluidos.');
    return { ...item, cantidad: 1, costoUnitario: accessoryUnitCost(lote) ?? undefined };
  });
  await devolverAccesoriosStock(manager, excluidos);
  await manager.getRepository(ProductoAccesoriosStock).update(productoId, {
    accesorios: [], revision: stock.revision + 1,
  });
  return partes;
}

export function detalleVentaConAccesorios(
  productoId: number, precioVenta: number, costoEquipo: number,
  accesorios: NonNullable<Venta['distribucionStock']>,
): Partial<Venta> {
  if (!accesorios.length) return {};
  const costoPendiente = accesorios.some((part) => part.costoUnitario == null);
  const costoTotal = costoEquipo + accesorios.reduce((sum, part) => sum + (part.costoUnitario ?? 0), 0);
  const ganancia = +(precioVenta - costoTotal).toFixed(2);
  return {
    distribucionStock: [{ productoId, cantidad: 1, costoUnitario: costoEquipo }, ...accesorios],
    costoPendiente,
    ganancia: costoPendiente ? 0 : ganancia,
    porcentajeGanancia: costoPendiente ? 0 : calculateProfitPercentage(ganancia, costoTotal),
  };
}

export async function liberarAccesoriosAlRetirarProducto(manager: EntityManager, producto: Producto) {
  if (producto.tipo.toLowerCase() === 'accesorios') {
    const enUso = await manager.query(
      'SELECT 1 FROM producto_accesorios_stock WHERE accesorios @> $1::jsonb LIMIT 1',
      [JSON.stringify([{ productoId: producto.id }])],
    );
    if (enUso.length) throw new ConflictException('Quita este accesorio de los equipos que lo incluyen antes de retirar su lote.');
    return;
  }
  const stock = await leerAccesoriosStock(manager, producto.id);
  if (!stock.accesorios.length) return;
  await devolverAccesoriosStock(manager, stock.accesorios);
  await manager.getRepository(ProductoAccesoriosStock).update(producto.id, {
    accesorios: [], revision: stock.revision + 1,
  });
}
