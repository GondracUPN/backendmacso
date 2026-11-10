import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConstanciaVentaOculta1794268800000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE venta ADD COLUMN IF NOT EXISTS "constanciaOcultaAt" timestamptz');
    await q.query('ALTER TABLE venta ADD COLUMN IF NOT EXISTS "constanciaOcultaPor" integer');
  }

  async down(): Promise<void> {
    throw new Error('Se conserva el historial de ventas retiradas de las constancias.');
  }
}
