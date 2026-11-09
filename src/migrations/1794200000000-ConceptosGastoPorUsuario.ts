import { MigrationInterface, QueryRunner } from 'typeorm';
import { migrationTable } from '../common/migration-table';

// Idempotente: en local la columna puede existir ya por synchronize (catalog/catalog-item.entity.ts).
// Los conceptos existentes quedan con ownerUserId NULL y siguen visibles para todos.
export class ConceptosGastoPorUsuario1794200000000
  implements MigrationInterface
{
  async up(q: QueryRunner): Promise<void> {
    const table = migrationTable(q, 'app_catalog_items');
    await q.query(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "ownerUserId" integer`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS idx_catalog_owner_user ON ${table} ("ownerUserId")`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    const table = migrationTable(q, 'app_catalog_items');
    await q.query('DROP INDEX IF EXISTS idx_catalog_owner_user');
    await q.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS "ownerUserId"`);
  }
}
