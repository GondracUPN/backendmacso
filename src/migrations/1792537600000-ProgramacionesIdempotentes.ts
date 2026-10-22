import { migrationTable } from '../common/migration-table';
import { MigrationInterface, QueryRunner } from 'typeorm';
export class ProgramacionesIdempotentes1792537600000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'scheduled_charges')} ADD COLUMN IF NOT EXISTS anchor_day smallint`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'gastos')} ADD COLUMN IF NOT EXISTS scheduled_charge_id integer`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'gastos')} ADD COLUMN IF NOT EXISTS scheduled_period date`);
    await qr.query(`CREATE UNIQUE INDEX IF NOT EXISTS gastos_programacion_periodo_unique ON ${migrationTable(qr, 'gastos')} (scheduled_charge_id, scheduled_period) WHERE scheduled_charge_id IS NOT NULL AND scheduled_period IS NOT NULL`);
  }
  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP INDEX IF EXISTS ${migrationTable(qr, 'gastos_programacion_periodo_unique')}`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'gastos')} DROP COLUMN IF EXISTS scheduled_period`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'gastos')} DROP COLUMN IF EXISTS scheduled_charge_id`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'scheduled_charges')} DROP COLUMN IF EXISTS anchor_day`);
  }
}
