import { ensureCostosPendientes } from '../db/financial-schema';
import { migrationTable } from '../common/migration-table';
import { MigrationInterface, QueryRunner } from 'typeorm';
export class CostosPendientes1792537500000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await ensureCostosPendientes(qr);
  }
  async down(qr: QueryRunner): Promise<void> {
    for (const col of ['costoCompletadoTotal', 'costoDocumento', 'costoCompletadoPor', 'costoCompletadoAt']) await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} DROP COLUMN IF EXISTS "${col}"`);
  }
}
