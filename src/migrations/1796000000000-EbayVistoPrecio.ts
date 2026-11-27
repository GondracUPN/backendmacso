import { MigrationInterface, QueryRunner } from 'typeorm';

/** Guarda el primer precio visto de cada artículo de eBay para comparar después. Idempotente. */
export class EbayVistoPrecio1796000000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`ALTER TABLE ebay_viewed_items ADD COLUMN IF NOT EXISTS viewed_price numeric(12,2)`);
    await q.query(`ALTER TABLE ebay_viewed_items ADD COLUMN IF NOT EXISTS viewed_currency varchar(8)`);
  }

  async down() { /* Conserva los precios guardados. */ }
}
