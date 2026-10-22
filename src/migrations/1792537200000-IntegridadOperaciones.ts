import { migrationTable } from '../common/migration-table';
import { MigrationInterface, QueryRunner } from 'typeorm';

export class IntegridadOperaciones1792537200000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} ADD COLUMN IF NOT EXISTS "operacionHash" varchar(64)`);
    // La unicidad de equipos se asegura bloqueando la fila del producto; un índice
    // parcial no puede consultar el tipo de otra tabla y bloquearía accesorios.
  }
  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} DROP COLUMN IF EXISTS "operacionHash"`);
  }
}
