import { MigrationInterface, QueryRunner } from 'typeorm';
import { migrationTable as table } from '../common/migration-table';

export class VinculosAccesorios1792537900000 implements MigrationInterface {
  name = 'VinculosAccesorios1792537900000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE ${table(q, 'accesorio_vinculo_propuesta')} (
      id SERIAL PRIMARY KEY, "productoId" integer NOT NULL REFERENCES ${table(q, 'producto')}(id) ON DELETE RESTRICT,
      "referenciaId" integer NULL REFERENCES ${table(q, 'accesorio_referencia')}(id) ON DELETE RESTRICT,
      "datosReferenciaPropuesta" jsonb NULL, grupo text NOT NULL, "productoIds" jsonb NOT NULL,
      snapshot jsonb NOT NULL, "snapshotHash" varchar(64) NOT NULL, puntuacion integer NOT NULL,
      motivo text NOT NULL, ambigua boolean NOT NULL DEFAULT false, "posibleDuplicado" boolean NOT NULL DEFAULT false,
      estado varchar NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','aceptada','rechazada','obsoleta')),
      "createdAt" timestamptz NOT NULL DEFAULT now(), "resueltoAt" timestamptz NULL, "resueltoPor" text NULL
    )`);
    await q.query(`CREATE UNIQUE INDEX uq_vinculo_pendiente_grupo ON ${table(q, 'accesorio_vinculo_propuesta')} (grupo) WHERE estado='pendiente'`);
    await q.query(`CREATE INDEX idx_vinculo_estado_puntuacion ON ${table(q, 'accesorio_vinculo_propuesta')} (estado,puntuacion)`);
    await q.query(`CREATE TABLE ${table(q, 'accesorio_vinculo_auditoria')} (
      id SERIAL PRIMARY KEY, "productoId" integer NOT NULL REFERENCES ${table(q, 'producto')}(id) ON DELETE RESTRICT,
      "referenciaIdAnterior" integer NULL REFERENCES ${table(q, 'accesorio_referencia')}(id) ON DELETE RESTRICT,
      "referenciaIdNuevo" integer NULL REFERENCES ${table(q, 'accesorio_referencia')}(id) ON DELETE RESTRICT,
      accion varchar NOT NULL CHECK (accion IN ('vincular','desvincular')),
      "loteId" integer NULL REFERENCES ${table(q, 'accesorio_vinculo_propuesta')}(id) ON DELETE RESTRICT,
      "revierteAuditoriaId" integer NULL REFERENCES ${table(q, 'accesorio_vinculo_auditoria')}(id) ON DELETE RESTRICT,
      usuario text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE INDEX idx_vinculo_auditoria_producto ON ${table(q, 'accesorio_vinculo_auditoria')} ("productoId",id DESC)`);
    await q.query(`CREATE UNIQUE INDEX uq_vinculo_reversion ON ${table(q, 'accesorio_vinculo_auditoria')} ("revierteAuditoriaId") WHERE "revierteAuditoriaId" IS NOT NULL`);
    await q.query(`CREATE TABLE ${table(q, 'accesorio_vinculo_operacion')} (
      id SERIAL PRIMARY KEY, accion varchar NOT NULL, "idempotencyKey" varchar(100) NOT NULL,
      "operationHash" varchar(64) NOT NULL, resultado jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
      UNIQUE (accion,"idempotencyKey")
    )`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE ${table(q, 'accesorio_vinculo_operacion')}`);
    await q.query(`DROP TABLE ${table(q, 'accesorio_vinculo_auditoria')}`);
    await q.query(`DROP TABLE ${table(q, 'accesorio_vinculo_propuesta')}`);
  }
}
