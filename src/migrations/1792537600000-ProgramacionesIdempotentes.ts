import { ensureProgramacionesIdempotentes } from '../db/financial-schema';
import { migrationTable } from '../common/migration-table';
import { MigrationInterface, QueryRunner } from 'typeorm';
export class ProgramacionesIdempotentes1792537600000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await ensureProgramacionesIdempotentes(qr);
  }
  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP INDEX IF EXISTS ${migrationTable(qr, 'gastos_programacion_periodo_unique')}`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'gastos')} DROP COLUMN IF EXISTS scheduled_period`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'gastos')} DROP COLUMN IF EXISTS scheduled_charge_id`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'scheduled_charges')} DROP COLUMN IF EXISTS anchor_day`);
  }
}
