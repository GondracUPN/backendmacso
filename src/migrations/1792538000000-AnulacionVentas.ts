import { ensureAnulacionVentas } from '../db/financial-schema';
import { migrationTable } from '../common/migration-table';
import { MigrationInterface, QueryRunner } from 'typeorm';
export class AnulacionVentas1792538000000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await ensureAnulacionVentas(qr);
  }
  async down(qr: QueryRunner): Promise<void> {
    for (const col of ['anuladaAt', 'anuladaPor', 'anulacionMotivo']) await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} DROP COLUMN IF EXISTS "${col}"`);
  }
}
