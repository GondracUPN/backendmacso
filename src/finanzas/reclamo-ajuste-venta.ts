import { EntityManager } from 'typeorm';
import { Reembolso } from './entities/reembolso.entity';
import { fromCents, toCents } from './finanzas-calc';

/** Tipo de cambio general cuando el equipo aún no tiene venta. */
export const TC_GENERAL_RECLAMO = 3.7;

type VentaTc = { id: number; tipoCambio: number | null };

/** Venta vigente del producto que recibe el ajuste de una devolución parcial. */
export async function ventaVigenteProducto(m: EntityManager, productoId: number): Promise<VentaTc | null> {
  const [v] = await m.query(
    `SELECT id, "tipoCambio" FROM venta WHERE "productoId"=$1 AND "anuladaAt" IS NULL AND "estadoComercial"<>'cancelada'
     ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [productoId],
  );
  return v ? { id: Number(v.id), tipoCambio: v.tipoCambio == null ? null : Number(v.tipoCambio) } : null;
}

/** TC de la venta si existe; si no, el general de 3.7. */
export const tcReclamoParcial = (venta?: VentaTc | null) =>
  Number(venta?.tipoCambio) > 0 ? Number(venta!.tipoCambio) : TC_GENERAL_RECLAMO;

/**
 * Equipo dañado: lo que me devuelven (USD al TC de la venta) baja el costo del equipo (costoDevuelto)
 * y lo que devuelvo al cliente baja el ingreso (precioDevuelto). Así la ganancia de la venta queda real.
 */
export async function aplicarReclamoParcialAVenta(m: EntityManager, r: Reembolso, venta: VentaTc) {
  if (r.tipoReclamo !== 'dano_parcial' || r.estado === 'anulado' || r.reversionReclamo?.ajusteVenta) return false;
  const tc = tcReclamoParcial(venta);
  const costoCents = Math.round(toCents(r.montoReclamado) * tc);
  const precioCents = toCents(r.saldoClientePen ?? 0);
  await m.query(
    `UPDATE venta SET "costoDevuelto"=COALESCE("costoDevuelto",0)+$2::numeric,
       "precioDevuelto"=COALESCE("precioDevuelto",0)+$3::numeric WHERE id=$1`,
    [venta.id, fromCents(costoCents).toFixed(2), fromCents(precioCents).toFixed(2)],
  );
  // El reclamo queda valorizado al mismo TC que la venta.
  r.tipoCambioCompra = tc.toFixed(4);
  r.costoOriginal = fromCents(costoCents).toFixed(2);
  r.reversionReclamo = {
    cierreMotivo: r.reversionReclamo?.cierreMotivo ?? null,
    ventas: r.reversionReclamo?.ventas || [],
    ajusteVenta: { ventaId: venta.id, costoCents, precioCents },
  };
  await m.getRepository(Reembolso).save(r);
  return true;
}

/** Al anular el reclamo se retira exactamente el ajuste aplicado. */
export async function revertirAjusteReclamoParcial(m: EntityManager, r: Reembolso) {
  const a = r.reversionReclamo?.ajusteVenta;
  if (!a) return false;
  await m.query(
    `UPDATE venta SET "costoDevuelto"=GREATEST(0,COALESCE("costoDevuelto",0)-$2::numeric),
       "precioDevuelto"=GREATEST(0,COALESCE("precioDevuelto",0)-$3::numeric) WHERE id=$1`,
    [a.ventaId, fromCents(a.costoCents).toFixed(2), fromCents(a.precioCents).toFixed(2)],
  );
  r.reversionReclamo = { ...r.reversionReclamo!, ajusteVenta: null };
  return true;
}

/** Venta registrada después de un reclamo parcial: el reembolso baja su costo al TC de esa venta. */
export async function aplicarReclamosParcialesPendientes(m: EntityManager, productoId: number, venta: VentaTc) {
  const pendientes = await m.query(
    `SELECT id FROM reembolsos WHERE producto_id=$1 AND tipo_reclamo='dano_parcial' AND estado<>'anulado' LIMIT 1`,
    [productoId],
  );
  if (!Array.isArray(pendientes) || !pendientes.length) return 0;
  const reclamos = await m.getRepository(Reembolso).createQueryBuilder('r')
    .where('r.productoId=:productoId', { productoId })
    .andWhere("r.tipoReclamo='dano_parcial'")
    .andWhere("r.estado<>'anulado'")
    .orderBy('r.id', 'ASC').setLock('pessimistic_write').getMany();
  let aplicados = 0;
  for (const r of reclamos) if (await aplicarReclamoParcialAVenta(m, r, venta)) aplicados++;
  return aplicados;
}
