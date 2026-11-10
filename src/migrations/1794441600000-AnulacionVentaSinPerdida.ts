import { MigrationInterface, QueryRunner } from 'typeorm';

export class AnulacionVentaSinPerdida1794441600000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    // Retira el cierre automático de una anulación con saldo, conservando reclamos y devoluciones.
    await q.query(`UPDATE producto p SET "cierreMotivo"=NULL
      WHERE p."cierreMotivo"='no_comercializable' AND p."archivadoAt" IS NULL
        AND EXISTS (SELECT 1 FROM venta v JOIN cliente_saldos s ON s.venta_id=v.id
          WHERE v."productoId"=p.id AND v."anuladaAt" IS NOT NULL
            AND v."anulacionMotivo"='Anulación: pago conservado como saldo a favor del cliente'
            AND s.motivo='Venta anulada y pago conservado como saldo a favor del cliente'
            AND s.anulada_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM reembolsos r WHERE r.producto_id=p.id AND r.estado<>'anulado')
        AND NOT EXISTS (SELECT 1 FROM venta_devoluciones d JOIN venta v ON v.id=d."ventaId" WHERE v."productoId"=p.id)`);
  }

  async down(): Promise<void> {
    throw new Error('Anular una venta no debe volver a marcar el producto como perdido.');
  }
}
