import { MigrationInterface, QueryRunner } from 'typeorm';

/** Corrección confirmada por el usuario: MS-478 se anuló sin cobrar S/ 1,300. */
export class CorregirSaldoJorge478SinCobro1794528000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    const candidatos = await q.query(`SELECT s.id,s.pago_id
      FROM cliente_saldos s JOIN clientes_comerciales c ON c.id=s.cliente_id
      JOIN venta v ON v.id=s.venta_id JOIN producto pr ON pr.id=v."productoId"
      JOIN venta_pagos p ON p.id=s.pago_id
      WHERE c.pedido_key='jorge' AND COALESCE(pr."codigoInventario",pr.id)=478
        AND s.original=1300 AND s.disponible=1300 AND s.anulada_at IS NULL
        AND v."precioVenta"=1300 AND v."estadoComercial"='cancelada' AND v."anuladaAt" IS NOT NULL
        AND p.origen='ingreso_venta' AND p.saldo_convertido=1300
        AND NOT EXISTS (SELECT 1 FROM cliente_saldo_movimientos m WHERE m.saldo_id=s.id)
        AND NOT EXISTS (SELECT 1 FROM venta_pagos credito WHERE credito.venta_id=v.id AND credito.origen='saldo_cliente')
      FOR UPDATE OF s,p`);
    if (candidatos.length > 1) throw new Error('La corrección de MS-478 requiere una única venta sin cobro.');
    for (const s of candidatos) {
      await q.query(`UPDATE cliente_saldos SET disponible=0, anulada_at=now(),
        motivo=motivo || ' · Corrección confirmada: MS-478 fue una venta registrada por error, anulada sin cobrar S/ 1,300.'
        WHERE id=$1`, [s.id]);
      await q.query('UPDATE venta_pagos SET saldo_convertido=0 WHERE id=$1', [s.pago_id]);
    }
  }

  async down(): Promise<void> {
    throw new Error('No se debe reactivar el saldo de MS-478: el cliente confirmó que nunca pagó ese dinero.');
  }
}
