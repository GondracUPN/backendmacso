import { EntityManager, In, IsNull, Like } from 'typeorm';
import { Producto } from './producto.entity';
import { ProductoValor } from './producto-valor.entity';
import { ProductoDetalle } from './producto-detalle.entity';
import { Venta } from '../venta/venta.entity';
import { VentaAdelanto } from '../venta/venta-adelanto.entity';
import { VentaDevolucion } from '../venta/venta-devolucion.entity';
import { unidadesPorReponer } from '../venta/stock-restore';
import { getAccessoryUnitCost } from '../venta/venta.service';
import { VentaPago } from '../finanzas/entities/venta-pago.entity';
import { PagoLiquidacion } from '../finanzas/entities/pago-liquidacion.entity';
import { Reembolso } from '../finanzas/entities/reembolso.entity';
import { ReembolsoEvento } from '../finanzas/entities/reembolso-evento.entity';
import { Gasto } from '../gastos/entities/gasto.entity';
import { Tracking } from '../tracking/tracking.entity';
import { Inventario } from '../inventario/inventario.entity';
import { AccesorioVinculoAuditoria, AccesorioVinculoPropuesta } from '../accesorios/accesorio-vinculo.entity';

export type EliminacionProducto = {
  productoId: number;
  ventas: number;
  adelantos: number;
  devoluciones: number;
  pagos: number;
  liquidaciones: number;
  gastos: number;
  gastosDesvinculados: number;
  reembolsos: number;
  reembolsoEventos: number;
  unidadesRepuestas: number;
  ventasCompartidasConservadas: number;
  vinculosAccesorio: number;
};

/**
 * Borrado físico de un producto con todo el historial exclusivo de su operación.
 * Debe ejecutarse dentro de una transacción que ya bloqueó el producto y la topología de
 * accesorios; respeta el orden de las claves foráneas y nunca toca otros productos más allá
 * de reponer las unidades que sus ventas borradas habían tomado de otros lotes.
 */
export async function eliminarProductoDefinitivo(manager: EntityManager, producto: Producto): Promise<EliminacionProducto> {
  const id = producto.id;
  const repo = <T>(entity: new () => T) => manager.getRepository(entity as any) as any;

  await manager.query('SELECT id FROM venta WHERE "productoId" = $1 ORDER BY id FOR UPDATE', [id]);
  const ventas: Venta[] = await repo(Venta).find({ where: { productoId: id }, order: { id: 'ASC' } });
  const ventaIds = ventas.map((v) => v.id);
  const adelantos: VentaAdelanto[] = await repo(VentaAdelanto).find({ where: { productoId: id } });
  const adelantoIds = adelantos.map((a) => a.id);
  const devoluciones: VentaDevolucion[] = ventaIds.length ? await repo(VentaDevolucion).find({ where: { ventaId: In(ventaIds) } }) : [];

  // 1) Unidades que las ventas borradas tomaron de otros lotes vuelven a su stock (una sola vez).
  const reponer = new Map<number, number>();
  for (const venta of ventas) {
    if (venta.anuladaAt) continue; // la anulación ya las repuso
    for (const part of unidadesPorReponer(venta, devoluciones.filter((d) => d.ventaId === venta.id))) {
      if (part.productoId !== id) reponer.set(part.productoId, (reponer.get(part.productoId) || 0) + part.cantidad);
    }
  }
  const lotesAjenos = [...reponer.keys()].sort((a, b) => a - b);
  let unidadesRepuestas = 0;
  if (lotesAjenos.length) {
    await manager.query('SELECT id FROM producto WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [lotesAjenos]);
    for (const loteId of lotesAjenos) {
      const lote: Producto | null = await repo(Producto).findOne({ where: { id: loteId } });
      if (!lote) continue;
      await repo(Producto).update(loteId, { stockActual: Number(lote.stockActual || 0) + reponer.get(loteId)! });
      unidadesRepuestas += reponer.get(loteId)!;
    }
  }

  // 2) Ventas independientes que tomaron unidades de este lote: se conservan con su costo fijado.
  const compartidas: Array<{ id: number }> = await manager.query(
    `SELECT v.id FROM venta v WHERE v."productoId" <> $1 AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(v."distribucionStock", '[]'::jsonb)) x WHERE (x->>'productoId')::int = $1)
     ORDER BY v.id FOR UPDATE`, [id]);
  const costoUnitario = producto.valor ? +getAccessoryUnitCost(producto).toFixed(4) : null;
  for (const { id: ventaId } of compartidas) {
    const venta: Venta = await repo(Venta).findOne({ where: { id: ventaId } });
    if (!venta?.distribucionStock?.some((row) => Number(row.productoId) === id && row.costoUnitario == null)) continue;
    if (costoUnitario == null) continue;
    const distribucionStock = venta.distribucionStock.map((row) => Number(row.productoId) === id && row.costoUnitario == null
      ? { ...row, costoUnitario } : row);
    await repo(Venta).update(ventaId, { distribucionStock });
  }

  // 3) Gastos generados por la operación (ingresos, adelantos, devoluciones, reembolsos e ITF).
  const reembolsos: Reembolso[] = await repo(Reembolso).find({ where: { productoId: id } });
  const reembolsoIds = reembolsos.map((r) => r.id);
  const reembolsoEventos: ReembolsoEvento[] = reembolsoIds.length ? await repo(ReembolsoEvento).find({ where: { reembolsoId: In(reembolsoIds) } }) : [];
  const legacy = `__SALE_INCOME__:${id}`;
  const condiciones: any[] = [
    ...(ventaIds.length ? [{ saleId: In(ventaIds) }] : []),
    ...adelantoIds.map((adelantoId) => ({ concepto: 'ingreso', notas: Like(`__SALE_ADVANCE__:${adelantoId}:%`) })),
    { concepto: 'ingreso', metodoPago: 'debito', saleId: IsNull(), notas: In([legacy, String(id), ...['direct', 'card', 'debt', 'cash'].map((t) => `${legacy}:${t}`)]) },
  ];
  const eventoGastoIds = reembolsoEventos.map((e) => e.gastoId).filter((g): g is number => Boolean(g));
  if (eventoGastoIds.length) condiciones.push({ id: In(eventoGastoIds), notas: Like('__REFUND__:%') });
  const generados: Gasto[] = await repo(Gasto).find({ where: condiciones });
  const borrar = new Map<number, Gasto>(generados.map((g) => [g.id, g]));

  // Gastos manuales vinculados: se borran si su único vínculo es esta operación; si también
  // pertenecen a otro registro o a una deuda programada/en cuotas, solo se desvinculan.
  const vinculados: Gasto[] = await repo(Gasto).find({ where: [
    { productoVinculadoId: id },
    ...(ventaIds.length ? [{ ventaVinculadaId: In(ventaIds) }] : []),
  ] });
  let gastosDesvinculados = 0;
  for (const gasto of vinculados.filter((g) => !borrar.has(g.id))) {
    const productoPropio = gasto.productoVinculadoId === id;
    const ventaPropia = gasto.ventaVinculadaId != null && ventaIds.includes(gasto.ventaVinculadaId);
    const otroVinculo = (gasto.productoVinculadoId != null && !productoPropio) || (gasto.ventaVinculadaId != null && !ventaPropia);
    if (otroVinculo || gasto.scheduledChargeId || gasto.cuotasMeses || gasto.saleId) {
      await repo(Gasto).update(gasto.id, {
        ...(productoPropio ? { productoVinculadoId: null } : {}),
        ...(ventaPropia ? { ventaVinculadaId: null } : {}),
      });
      gastosDesvinculados++;
    } else borrar.set(gasto.id, gasto);
  }
  // El ITF automático se elimina junto con su ingreso.
  if (borrar.size) {
    const itf: Gasto[] = await repo(Gasto).find({ where: { itfIngresoId: In([...borrar.keys()]) } });
    itf.forEach((g) => borrar.set(g.id, g));
  }

  // 4) Pagos del libro (de las ventas y de sus reservas) con sus liquidaciones.
  const pagos: VentaPago[] = ventaIds.length || adelantoIds.length ? await repo(VentaPago).find({ where: [
    ...(ventaIds.length ? [{ ventaId: In(ventaIds) }] : []),
    ...(adelantoIds.length ? [{ adelantoId: In(adelantoIds) }] : []),
  ] }) : [];
  const pagoIds = pagos.map((p) => p.id);
  const liquidaciones: PagoLiquidacion[] = pagoIds.length ? await repo(PagoLiquidacion).find({ where: { pagoId: In(pagoIds) } }) : [];

  // 5) Borrado en orden de claves foráneas.
  if (devoluciones.length) await repo(VentaDevolucion).delete(devoluciones.map((d) => d.id));
  if (liquidaciones.length) await repo(PagoLiquidacion).delete(liquidaciones.map((l) => l.id));
  if (pagoIds.length) await repo(VentaPago).delete(pagoIds);
  if (borrar.size) await repo(Gasto).delete([...borrar.keys()]);
  if (ventaIds.length) await repo(Venta).delete(ventaIds);
  if (adelantoIds.length) await repo(VentaAdelanto).delete(adelantoIds);
  if (reembolsoEventos.length) await repo(ReembolsoEvento).delete(reembolsoEventos.map((e) => e.id));
  if (reembolsoIds.length) await repo(Reembolso).delete(reembolsoIds);
  const vinculosAccesorio = await limpiarVinculosAccesorio(manager, id);
  await repo(Tracking).delete({ productoId: id });
  await repo(Inventario).delete({ productoId: id });
  await repo(Producto).delete(id);
  // Valor y detalle solo se borran si ningún otro producto los comparte.
  for (const [entity, columna, valor] of [[ProductoValor, 'valorId', producto.valor], [ProductoDetalle, 'detalleId', producto.detalle]] as const) {
    if (!valor?.id) continue;
    const [{ n }] = await manager.query(`SELECT count(*)::int AS n FROM producto WHERE "${columna}" = $1`, [valor.id]);
    if (!Number(n)) await repo(entity as any).delete(valor.id);
  }

  return {
    productoId: id, ventas: ventaIds.length, adelantos: adelantoIds.length, devoluciones: devoluciones.length,
    pagos: pagoIds.length, liquidaciones: liquidaciones.length, gastos: borrar.size, gastosDesvinculados,
    reembolsos: reembolsoIds.length, reembolsoEventos: reembolsoEventos.length, unidadesRepuestas,
    ventasCompartidasConservadas: compartidas.length, vinculosAccesorio,
  };
}

async function limpiarVinculosAccesorio(manager: EntityManager, id: number): Promise<number> {
  const auditorias = manager.getRepository(AccesorioVinculoAuditoria);
  const propuestas = manager.getRepository(AccesorioVinculoPropuesta);
  const propias = await auditorias.find({ where: { productoId: id } });
  // Las reversiones se borran antes que las auditorías que revierten.
  const reversiones = propias.filter((a) => a.revierteAuditoriaId != null);
  if (reversiones.length) await auditorias.delete(reversiones.map((a) => a.id));
  const resto = propias.filter((a) => a.revierteAuditoriaId == null);
  if (resto.length) await auditorias.delete(resto.map((a) => a.id));
  let cambios = propias.length;
  const afectadas: AccesorioVinculoPropuesta[] = await manager.query(
    `SELECT id FROM accesorio_vinculo_propuesta WHERE "productoId" = $1 OR "productoIds" @> to_jsonb($1::int) ORDER BY id FOR UPDATE`, [id]);
  for (const { id: propuestaId } of afectadas) {
    const propuesta = await propuestas.findOne({ where: { id: propuestaId } });
    if (!propuesta) continue;
    const productoIds = (propuesta.productoIds || []).filter((p) => Number(p) !== id);
    if (!productoIds.length) {
      // Sin otros lotes la propuesta deja de tener sentido; las auditorías ajenas pierden solo la referencia.
      await auditorias.update({ loteId: propuestaId }, { loteId: null });
      await propuestas.delete(propuestaId);
    } else {
      await propuestas.update(propuestaId, {
        productoIds,
        ...(propuesta.productoId === id && productoIds.length ? { productoId: productoIds[0] } : {}),
        ...(propuesta.estado === 'pendiente' ? { estado: 'obsoleta' as const } : {}),
      });
    }
    cambios++;
  }
  return cambios;
}
