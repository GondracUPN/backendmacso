import { MigrationInterface, QueryRunner } from "typeorm";

export class DropConCajaAndBackfill1700000000002 implements MigrationInterface {
  name = 'DropConCajaAndBackfill1700000000002'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "producto" ADD COLUMN IF NOT EXISTS "accesorios" text[] NOT NULL DEFAULT '{}'`);
    await queryRunner.query(`UPDATE "producto" SET "accesorios" = ARRAY['Caja','Cubo','Cable'] WHERE LOWER("estado") = 'nuevo'`);
    await queryRunner.query(`ALTER TABLE "producto" DROP COLUMN IF EXISTS "conCaja"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "producto" ADD COLUMN IF NOT EXISTS "conCaja" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "producto" DROP COLUMN IF EXISTS "accesorios"`);
  }
}
