import { ensureSistemaFinanciero } from '../db/financial-schema';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sistema financiero integrado.
 *
 * - Solo agrega tablas y columnas; no modifica ni elimina datos existentes.
 * - Las ventas que existen al ejecutar la migración quedan marcadas como
 *   "conciliación histórica pendiente": no se asumen cobradas ni se crean pagos.
 * - Es idempotente (IF NOT EXISTS) porque el esquema de producción se creó con
 *   synchronize y ajustes de arranque, no con migraciones.
 */
export class SistemaFinanciero1760832000000 implements MigrationInterface {
  name = 'SistemaFinanciero1760832000000';

  public async up(q: QueryRunner): Promise<void> {
    await ensureSistemaFinanciero(q);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Revierte solo lo agregado por esta migración. Los datos registrados en las
    // tablas nuevas se pierden: respalda antes de revertir.
    await q.query(`DROP TABLE IF EXISTS "reembolso_eventos"`);
    await q.query(`DROP TABLE IF EXISTS "reembolsos"`);
    await q.query(`DROP TABLE IF EXISTS "movimientos_financieros"`);
    await q.query(`DROP TABLE IF EXISTS "pago_liquidaciones"`);
    await q.query(`DROP TABLE IF EXISTS "venta_pagos"`);
    await q.query(`DROP TABLE IF EXISTS "cuentas_financieras"`);
    await q.query(`DROP INDEX IF EXISTS "idx_gastos_fecha"`);
    await q.query(`DROP INDEX IF EXISTS "idx_gastos_sale_id"`);
    await q.query(`DROP INDEX IF EXISTS "idx_gastos_venta_vinculada"`);
    await q.query(
      `ALTER TABLE "gastos" DROP COLUMN IF EXISTS "producto_vinculado_id"`,
    );
    await q.query(
      `ALTER TABLE "gastos" DROP COLUMN IF EXISTS "venta_vinculada_id"`,
    );
    await q.query(
      `ALTER TABLE "gastos" DROP COLUMN IF EXISTS "clasificacion_financiera"`,
    );
    await q.query(
      `ALTER TABLE "producto" DROP COLUMN IF EXISTS "cierreMotivo"`,
    );
    await q.query(`ALTER TABLE "producto" DROP COLUMN IF EXISTS "origen"`);
    for (const column of [
      'motivoCancelacion',
      'montoDevuelto',
      'fechaDevolucion',
      'canceladoAt',
    ]) {
      await q.query(
        `ALTER TABLE "venta_adelanto" DROP COLUMN IF EXISTS "${column}"`,
      );
    }
    await q.query(`DROP INDEX IF EXISTS "idx_venta_grupo_operacion"`);
    await q.query(`DROP INDEX IF EXISTS "idx_venta_fecha_venta"`);
    await q.query(`DROP INDEX IF EXISTS "uq_venta_operacion_key"`);
    for (const column of [
      'operacionKey',
      'ventaRapida',
      'grupoOperacion',
      'costoPendiente',
      'conciliadaAt',
      'conciliacionNota',
      'conciliacionHistorica',
      'estadoComercial',
      'moneda',
      'descuento',
      'precioLista',
      'fechaReserva',
    ]) {
      await q.query(`ALTER TABLE "venta" DROP COLUMN IF EXISTS "${column}"`);
    }
  }
}
