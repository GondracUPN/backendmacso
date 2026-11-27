import { MigrationInterface, QueryRunner } from 'typeorm';

export class EmpaqueYFusionAccesorio1795651200000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`ALTER TABLE producto ADD COLUMN IF NOT EXISTS "empaqueAccesorio" varchar(16),
      ADD COLUMN IF NOT EXISTS "fusionAccesorioId" integer`);
    await q.query(`CREATE INDEX IF NOT EXISTS producto_fusion_accesorio_idx ON producto ("fusionAccesorioId")`);
    await q.query(`DO $$ BEGIN
      ALTER TABLE producto ADD CONSTRAINT producto_empaque_accesorio_chk
        CHECK ("empaqueAccesorio" IS NULL OR (lower(tipo) = 'accesorios' AND "empaqueAccesorio" IN ('con_caja','sin_caja','sin_indicar')));
      EXCEPTION WHEN duplicate_object THEN NULL;
    END $$`);
  }

  async down() { /* Conserva la clasificación y las fusiones elegidas. */ }
}
