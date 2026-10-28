import { MigrationInterface, QueryRunner } from 'typeorm';
import { migrationTable } from '../common/migration-table';

export class ReferenciasAccesorios1792537800000 implements MigrationInterface {
  name = 'ReferenciasAccesorios1792537800000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE ${migrationTable(q, 'accesorio_referencia')} (
      id SERIAL PRIMARY KEY, categoria varchar NOT NULL, marca varchar NOT NULL DEFAULT '', modelo varchar NOT NULL,
      generacion varchar NOT NULL DEFAULT '', variante varchar NOT NULL DEFAULT '', estado varchar NOT NULL, originalidad varchar NOT NULL,
      compatibilidad text NULL, "fotoUrl" text NULL, "precioPublicadoSoles" numeric(12,2) NULL,
      "precioMinimoSoles" numeric(12,2) NULL, "precioMayoristaSoles" numeric(12,2) NULL, "cantidadMinimaMayorista" integer NULL,
      activo boolean NOT NULL DEFAULT true, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
    )`);
    const keys = ['categoria', 'marca', 'modelo', 'generacion', 'variante', 'estado', 'originalidad'];
    await q.query(`CREATE UNIQUE INDEX uq_accesorio_referencia_variante ON ${migrationTable(q, 'accesorio_referencia')} (${keys.map((key) => `lower(regexp_replace(btrim("${key}"), '\\s+', ' ', 'g'))`).join(', ')})`);
    await q.query(`ALTER TABLE ${migrationTable(q, 'producto')} ADD COLUMN "referenciaId" integer NULL REFERENCES ${migrationTable(q, 'accesorio_referencia')}(id) ON DELETE RESTRICT`);
    await q.query(`CREATE INDEX idx_producto_referencia ON ${migrationTable(q, 'producto')} ("referenciaId")`);
    await q.query(`ALTER TABLE ${migrationTable(q, 'producto_valor')} ADD COLUMN "tipoCambioCompra" numeric(12,6) NULL`);
    await q.query(`CREATE TABLE ${migrationTable(q, 'accesorio_ingreso')} (id SERIAL PRIMARY KEY, "idempotencyKey" varchar(100) NOT NULL UNIQUE,
      "operationHash" varchar(64) NOT NULL, resultado jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now())`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE ${migrationTable(q, 'accesorio_ingreso')}`);
    await q.query(`ALTER TABLE ${migrationTable(q, 'producto_valor')} DROP COLUMN "tipoCambioCompra"`);
    await q.query(`DROP INDEX ${migrationTable(q, 'idx_producto_referencia')}`);
    await q.query(`ALTER TABLE ${migrationTable(q, 'producto')} DROP COLUMN "referenciaId"`);
    await q.query(`DROP TABLE ${migrationTable(q, 'accesorio_referencia')}`);
  }
}
