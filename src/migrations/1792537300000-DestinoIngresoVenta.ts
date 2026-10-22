import { migrationTable } from '../common/migration-table';
import { MigrationInterface, QueryRunner } from 'typeorm';
export class DestinoIngresoVenta1792537300000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'gastos')} ADD COLUMN IF NOT EXISTS sale_cuenta_id integer`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'gastos')} ADD COLUMN IF NOT EXISTS sale_metodo varchar(20)`);
  }
  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'gastos')} DROP COLUMN IF EXISTS sale_metodo`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'gastos')} DROP COLUMN IF EXISTS sale_cuenta_id`);
  }
}
