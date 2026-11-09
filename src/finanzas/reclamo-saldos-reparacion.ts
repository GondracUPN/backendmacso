import { EntityManager } from 'typeorm';

/** Retira únicamente saldos automáticos sin cobro confirmado y nunca utilizados. */
export async function repararSaldosReclamoSinCobro(m: EntityManager, productoId: number) {
  const candidatos = await m.query(`SELECT s.id, s.pago_id, s.original, s.cliente_id,
      (SELECT r.id FROM reembolsos r WHERE r.producto_id=v."productoId" ORDER BY r.id DESC LIMIT 1) reembolso_id
    FROM cliente_saldos s JOIN venta v ON v.id=s.venta_id
    JOIN venta_pagos p ON p.id=s.pago_id JOIN gastos g ON g.id=p.gasto_id
    WHERE v."productoId"=$1 AND s.anulada_at IS NULL AND s.disponible=s.original
      AND v."anulacionMotivo"='Anulación: pago conservado como saldo a favor del cliente'
      AND s.motivo='Venta anulada y pago conservado como saldo a favor del cliente'
      AND p.origen='ingreso_venta' AND (g.sale_payment_type IS NULL OR g.sale_payment_type<>'direct')
      AND COALESCE(g.sale_received_amount,0)=0
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(g.sale_payment_history,'[]'::jsonb)) h WHERE COALESCE((h->>'amount')::numeric,0)>0)
      AND NOT EXISTS(SELECT 1 FROM cliente_saldo_movimientos mov WHERE mov.saldo_id=s.id)
      AND EXISTS(SELECT 1 FROM reembolsos r WHERE r.producto_id=v."productoId")
    ORDER BY s.id FOR UPDATE OF s,p`, [productoId]);
  for (const s of candidatos) {
    await m.query('UPDATE cliente_saldos SET disponible=0, anulada_at=now() WHERE id=$1', [s.id]);
    await m.query('UPDATE venta_pagos SET saldo_convertido=0 WHERE id=$1', [s.pago_id]);
    await m.query(`INSERT INTO reembolso_eventos(reembolso_id,tipo,fecha,moneda,nota,idempotency_key)
      VALUES($1,'nota',CURRENT_DATE,'PEN',$2,$3) ON CONFLICT (idempotency_key) DO NOTHING`,
      [s.reembolso_id, `Corrección de saldo automático ${s.id}: retirados S/ ${s.original} sin cobro confirmado; historial conservado.`, `saldo:${s.id}:sin-cobro:v1`]);
  }
  return candidatos;
}
