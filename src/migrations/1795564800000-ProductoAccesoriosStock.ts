import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProductoAccesoriosStock1795564800000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE IF NOT EXISTS producto_accesorios_stock (
      "productoId" integer PRIMARY KEY,
      accesorios jsonb NOT NULL DEFAULT '[]'::jsonb,
      revision integer NOT NULL DEFAULT 0,
      "revisionSincronizada" integer NOT NULL DEFAULT 0,
      CONSTRAINT producto_accesorios_stock_producto_fk
        FOREIGN KEY ("productoId") REFERENCES producto(id) ON DELETE CASCADE
    )`);
  }

  async down() { /* Conserva las reservas y su conciliación con el stock disponible. */ }
}
