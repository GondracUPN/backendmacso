import { EntityManager } from 'typeorm';

/** Recupera un cierre heredado de la cancelación automática, sin reabrir reclamos vigentes. */
export async function reabrirProductoConReclamosAnulados(m: EntityManager, productoId: number, reclamoAnulando?: number) {
  const [reabiertos] = await m.query(`UPDATE producto p SET "cierreMotivo"=NULL
    WHERE p.id=$1 AND p."archivadoAt" IS NULL AND p."cierreMotivo"='no_comercializable'
      AND EXISTS(SELECT 1 FROM reembolsos r WHERE r.producto_id=p.id)
      AND NOT EXISTS(SELECT 1 FROM reembolsos r WHERE r.producto_id=p.id AND r.estado<>'anulado' AND r.id<>COALESCE($2,0))
      AND EXISTS(SELECT 1 FROM venta v WHERE v."productoId"=p.id
        AND v."anulacionMotivo"='Anulación: pago conservado como saldo a favor del cliente')
    RETURNING p.id`, [productoId, reclamoAnulando ?? null]);
  if (reabiertos.length) await m.query(`INSERT INTO reembolso_eventos(reembolso_id,tipo,fecha,moneda,nota,idempotency_key)
    SELECT r.id,'nota',CURRENT_DATE,'PEN','Producto habilitado para vender: retirado cierre automático heredado tras anular los reclamos.',$2
    FROM reembolsos r WHERE r.producto_id=$1 ORDER BY r.id DESC LIMIT 1
    ON CONFLICT (idempotency_key) DO NOTHING`, [productoId, `producto:${productoId}:reabierto:reclamos-anulados`]);
  return reabiertos;
}
