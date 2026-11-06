import { MigrationInterface, QueryRunner } from 'typeorm';
export class AccesorioCatalogo1793740000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE IF NOT EXISTS accesorio_catalogo (
      key varchar(100) PRIMARY KEY, seleccionado boolean NOT NULL DEFAULT false,
      payload jsonb, "syncHash" varchar(64), error text, "sincronizadoAt" timestamptz,
      "updatedAt" timestamptz NOT NULL DEFAULT now())`);
  }
  async down(q: QueryRunner) { /* Mantener preferencias e historial de sincronización. */ }
}
