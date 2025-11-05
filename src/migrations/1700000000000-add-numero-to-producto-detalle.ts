import { MigrationInterface, QueryRunner } from "typeorm";

export class AddNumeroToProductoDetalle1700000000000 implements MigrationInterface {
  name = 'AddNumeroToProductoDetalle1700000000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Añade la columna "numero" (varchar, nullable) a la tabla de detalle
    await queryRunner.query(`ALTER TABLE "producto_detalle" ADD "numero" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "producto_detalle" DROP COLUMN "numero"`);
  }
}

