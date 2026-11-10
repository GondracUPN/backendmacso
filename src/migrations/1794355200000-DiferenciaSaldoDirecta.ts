import { MigrationInterface, QueryRunner } from 'typeorm';

export class DiferenciaSaldoDirecta1794355200000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    // Corrige únicamente etiquetas de los ingresos creados por aplicar saldo.
    await q.query(`UPDATE gastos g SET sale_sku =
      CASE WHEN lower(p.tipo)='accesorios' THEN 'ACC-' ELSE 'MS-' END || COALESCE(p."codigoInventario",p.id)::text
      FROM venta v JOIN producto p ON p.id=v."productoId"
      WHERE g.sale_id=v.id AND g.notas='__SALE_CREDIT_DIFFERENCE__:' || v.id::text`);
    await q.query(`UPDATE gastos g SET tarjeta=COALESCE(g.tarjeta,c.legacy_codigo,c.codigo)
      FROM cuentas_financieras c WHERE c.id=g.sale_cuenta_id
        AND g.notas='__SALE_CREDIT_DIFFERENCE__:' || g.sale_id::text AND g.tarjeta IS NULL`);
    await q.query(`UPDATE gastos g SET sale_payment_type='direct'
      WHERE g.sale_payment_type='debt' AND g.monto>0 AND g.sale_received_amount=g.monto
        AND g.notas='__SALE_CREDIT_DIFFERENCE__:' || g.sale_id::text
        AND EXISTS (SELECT 1 FROM venta_pagos p WHERE p.venta_id=g.sale_id
          AND p.idempotency_key LIKE 'extra:%' AND p.anulado_at IS NULL AND p.verificado=true
          AND p.monto_pen=g.monto AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(g.sale_payment_history,'[]'::jsonb)) h
            WHERE h->>'pagoId'=p.id::text))`);
  }

  async down(): Promise<void> {
    throw new Error('Se conserva la clasificación corregida de los pagos adicionales.');
  }
}
