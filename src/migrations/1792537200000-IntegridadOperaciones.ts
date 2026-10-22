import { ensureIntegridadOperaciones } from '../db/financial-schema';
import { migrationTable } from '../common/migration-table';
import { MigrationInterface, QueryRunner } from 'typeorm';

export class IntegridadOperaciones1792537200000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await ensureIntegridadOperaciones(qr);
  }
  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} DROP COLUMN IF EXISTS "operacionHash"`);
  }
}
