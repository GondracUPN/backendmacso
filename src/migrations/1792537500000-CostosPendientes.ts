import { migrationTable } from '../common/migration-table';
import { MigrationInterface, QueryRunner } from 'typeorm';
export class CostosPendientes1792537500000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} ADD COLUMN IF NOT EXISTS "costoCompletadoTotal" numeric(12,2)`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} ADD COLUMN IF NOT EXISTS "costoDocumento" text`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} ADD COLUMN IF NOT EXISTS "costoCompletadoPor" integer`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} ADD COLUMN IF NOT EXISTS "costoCompletadoAt" timestamptz`);
  }
  async down(qr: QueryRunner): Promise<void> {
    for (const col of ['costoCompletadoTotal', 'costoDocumento', 'costoCompletadoPor', 'costoCompletadoAt']) await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} DROP COLUMN IF EXISTS "${col}"`);
  }
}
