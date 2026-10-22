import { migrationTable, migrationSchema } from '../common/migration-table';
import { MigrationInterface, QueryRunner } from 'typeorm';

export class DevolucionesComerciales1792537400000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'producto')} ADD COLUMN IF NOT EXISTS "archivadoAt" timestamptz`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'producto')} ADD COLUMN IF NOT EXISTS "archivoMotivo" text`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} ADD COLUMN IF NOT EXISTS "costoDevuelto" numeric(12,2) NOT NULL DEFAULT 0`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} ADD COLUMN IF NOT EXISTS "precioDevuelto" numeric(12,2) NOT NULL DEFAULT 0`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} ADD COLUMN IF NOT EXISTS "cantidadDevuelta" integer NOT NULL DEFAULT 0`);
    await qr.query(`CREATE TABLE IF NOT EXISTS ${migrationTable(qr, 'venta_devoluciones')} (
      id serial PRIMARY KEY, "ventaId" integer NOT NULL REFERENCES ${migrationTable(qr, 'venta')}(id) ON DELETE RESTRICT,
      cantidad integer NOT NULL CHECK (cantidad > 0), monto numeric(12,2) NOT NULL CHECK (monto >= 0),
      "costoRecuperado" numeric(12,2) NOT NULL DEFAULT 0, destino varchar(20) NOT NULL,
      "precioAnulado" numeric(12,2) NOT NULL DEFAULT 0,
      fecha date NOT NULL, motivo text NOT NULL, "cuentaId" integer, "userId" integer,
      "operacionKey" varchar(100) NOT NULL UNIQUE, "operacionHash" varchar(64) NOT NULL,
      lotes jsonb NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now())`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta_devoluciones')} ADD COLUMN IF NOT EXISTS "precioAnulado" numeric(12,2) NOT NULL DEFAULT 0`);
    const table = await qr.getTable(`${migrationSchema(qr)}.venta`);
    for (const fk of table?.foreignKeys || []) {
      if (fk.columnNames.length === 1 && fk.columnNames[0] === 'productoId') await qr.dropForeignKey(table!, fk);
    }
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} ADD CONSTRAINT venta_producto_restrict_fk FOREIGN KEY ("productoId") REFERENCES ${migrationTable(qr, 'producto')}(id) ON DELETE RESTRICT`);
  }
  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} DROP CONSTRAINT IF EXISTS venta_producto_restrict_fk`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} ADD CONSTRAINT venta_producto_cascade_fk FOREIGN KEY ("productoId") REFERENCES ${migrationTable(qr, 'producto')}(id) ON DELETE CASCADE`);
    await qr.query(`DROP TABLE IF EXISTS ${migrationTable(qr, 'venta_devoluciones')}`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} DROP COLUMN IF EXISTS "costoDevuelto"`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} DROP COLUMN IF EXISTS "precioDevuelto"`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'venta')} DROP COLUMN IF EXISTS "cantidadDevuelta"`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'producto')} DROP COLUMN IF EXISTS "archivoMotivo"`);
    await qr.query(`ALTER TABLE ${migrationTable(qr, 'producto')} DROP COLUMN IF EXISTS "archivadoAt"`);
  }
}
