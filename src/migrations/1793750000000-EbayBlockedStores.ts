import { MigrationInterface, QueryRunner } from 'typeorm';

export class EbayBlockedStores1793750000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "ebay_blocked_stores" (
      "seller" varchar(255) PRIMARY KEY,
      "blocked" boolean NOT NULL DEFAULT true
    )`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "ebay_blocked_stores"');
  }
}
