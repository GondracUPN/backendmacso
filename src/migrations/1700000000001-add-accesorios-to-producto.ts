import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAccesoriosToProducto1700000000001 implements MigrationInterface {
  name = 'AddAccesoriosToProducto1700000000001'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Postgres: add text[] column with empty array default
    await queryRunner.query('ALTER TABLE "producto" ADD COLUMN "accesorios" text[] NOT NULL DEFAULT \'{}\' ');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "producto" DROP COLUMN "accesorios"');
  }
}

