import { BadRequestException } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { Producto } from '../producto/producto.entity';
import { operationHash } from './operation-hash';
import { accessoryLotCost } from '../producto/accessory-cost';

export const accessoryOwner = (value: unknown) => String(value || '').trim().toLowerCase();
export const accessoryAvailable = (lot: Partial<Producto>) =>
  String(lot.tipo).toLowerCase() === 'accesorios' && !lot.archivadoAt && !lot.cierreMotivo
    && !(lot.referenciaId && lot.origen === 'accesorio_importado' && !(lot.tracking || []).some((row) => row.fechaRecogido || String(row.estado).toLowerCase() === 'recogido'));

export const accessoryIdentity = (lot: Partial<Producto>) => lot.referenciaId ? 'ref:' + lot.referenciaId : 'code:' + Number(lot.codigoInventario || lot.id);
export const sameAccessoryGroup = (a: Partial<Producto>, b: Partial<Producto>) => accessoryIdentity(a) === accessoryIdentity(b) && accessoryOwner(a.vendedor) === accessoryOwner(b.vendedor);
// Los códigos heredados pueden haberse compartido por título. Sin referencia,
// solo una misma foto no vacía permite tratar altas distintas como un stock.
export function accessoryInventoryIdentity(lot: Partial<Producto>, fichas: { productoId: number; fotoUrl?: string | null }[]) {
  const photo = String(fichas.find((ficha) => Number(ficha.productoId) === Number(lot.id))?.fotoUrl || '').trim();
  return JSON.stringify(lot.referenciaId ? ['ref', lot.referenciaId]
    : ['code', Number(lot.codigoInventario || lot.id), photo ? ['photo', photo] : ['lot', lot.id]]);
}
export const sameAccessoryInventoryGroup = (a: Partial<Producto>, b: Partial<Producto>, fichas: { productoId: number; fotoUrl?: string | null }[]) =>
  accessoryInventoryIdentity(a, fichas) === accessoryInventoryIdentity(b, fichas) && accessoryOwner(a.vendedor) === accessoryOwner(b.vendedor);
export const accessoryGroupWhere = (lot: Producto) => lot.referenciaId ? [{ referenciaId: lot.referenciaId }] : [{ id: lot.id, referenciaId: IsNull() }, { codigoInventario: Number(lot.codigoInventario || lot.id), referenciaId: IsNull() }];

export function resolveAccessoryPrices(reference: Partial<Producto>, fichas: any[]) {
  const own = fichas.find((ficha) => Number(ficha.productoId) === reference.id);
  const latest = [...fichas].sort((a, b) => (Date.parse(b.updatedAt || '') || 0) - (Date.parse(a.updatedAt || '') || 0) || Number(b.id || b.productoId) - Number(a.id || a.productoId));
  const number = (value: any) => value == null ? null : Number(value);
  return { precioPublicado: number(reference.referencia?.precioPublicadoSoles ?? own?.primerPrecioSoles ?? latest.find((ficha) => ficha.primerPrecioSoles != null)?.primerPrecioSoles),
    precioMinimo: number(reference.referencia?.precioMinimoSoles ?? own?.ultimoPrecioSoles ?? latest.find((ficha) => ficha.ultimoPrecioSoles != null)?.ultimoPrecioSoles),
    precioMayorista: number(reference.referencia?.precioMayoristaSoles), cantidadMinimaMayorista: number(reference.referencia?.cantidadMinimaMayorista) };
}

export function accessoryLotDate(lot: Producto) {
  const purchase = Date.parse(String(lot.valor?.fechaCompra || ''));
  if (Number.isFinite(purchase)) return purchase;
  const dates = (lot.tracking || []).map((row) => row.fechaRecogido ||
    (String(row.estado).toLowerCase() === 'recogido' ? row.createdAt : null))
    .filter(Boolean).map((date) => new Date(date!).getTime()).filter(Number.isFinite);
  return dates.length ? Math.min(...dates) : lot.id;
}

/** Pure allocation shared by quotation and the transaction that consumes stock. */
export function allocateAccessory(lots: Producto[], reference: Producto, cantidad: number, loteInicialId?: number) {
  if (!Number.isSafeInteger(cantidad) || cantidad < 1) throw new BadRequestException('Cantidad inválida.');
  const code = Number(reference.codigoInventario || reference.id);
  const group = lots.filter((lot) => accessoryAvailable(lot)
    && sameAccessoryGroup(lot, reference))
    .sort((a, b) => accessoryLotDate(a) - accessoryLotDate(b) || a.id - b.id);
  if (loteInicialId != null) {
    const index = group.findIndex((lot) => lot.id === loteInicialId);
    if (index < 0) throw new BadRequestException('El lote seleccionado no pertenece a este accesorio y comprador.');
    if (Number(group[index].stockActual) < 1) throw new BadRequestException('El lote seleccionado no tiene stock.');
    group.unshift(group.splice(index, 1)[0]);
  }
  const disponible = group.reduce((sum, lot) => sum + Math.max(0, Number(lot.stockActual)), 0);
  if (disponible < cantidad) throw new BadRequestException(`Stock insuficiente de ${reference.vendedor || 'este comprador'}. Quedan ${disponible} unidades.`);
  let pending = cantidad;
  const lotes = group.flatMap((lot) => {
    const take = Math.min(pending, Math.max(0, Number(lot.stockActual)));
    pending -= take;
    const cost = accessoryLotCost(lot);
    const unit = cost == null ? null : Number(cost) / Math.max(1, Number(lot.stockInicial));
    return take > 0 ? [{ productoId: lot.id, cantidad: take, costoUnitario: unit }] : [];
  });
  const costoPendiente = lotes.some((lot) => lot.costoUnitario == null);
  const costoTotal = costoPendiente ? null : Number(lotes.reduce((sum, lot) => sum + lot.cantidad * lot.costoUnitario!, 0).toFixed(2));
  const token = operationHash({ code: reference.referenciaId ? accessoryIdentity(reference) : code, comprador: accessoryOwner(reference.vendedor), cantidad, loteInicialId,
    lotes, stock: group.map((lot) => ({ id: lot.id, stock: Number(lot.stockActual) })).sort((a, b) => a.id - b.id) });
  return { lotes, costoTotal, costoPendiente, disponible, cotizacionToken: token };
}
