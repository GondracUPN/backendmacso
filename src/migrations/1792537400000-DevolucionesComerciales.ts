import { ensureDevolucionesComerciales } from '../db/financial-schema';
import { migrationTable } from '../common/migration-table';
import { MigrationInterface, QueryRunner } from 'typeorm';

export class DevolucionesComerciales1792537400000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await ensureDevolucionesComerciales(qr);
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
