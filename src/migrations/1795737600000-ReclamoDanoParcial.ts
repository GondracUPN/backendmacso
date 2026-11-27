import { MigrationInterface, QueryRunner } from 'typeorm';

/** Reclamo por equipo dañado: devolución parcial y saldo a favor sin pago origen. */
export class ReclamoDanoParcial1795737600000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`ALTER TABLE reembolsos
      ADD COLUMN IF NOT EXISTS tipo_reclamo varchar(20) NOT NULL DEFAULT 'no_llego',
      ADD COLUMN IF NOT EXISTS saldo_cliente_pen numeric(12,2)`);
    await q.query('ALTER TABLE cliente_saldos ADD COLUMN IF NOT EXISTS reembolso_id integer');
    await q.query('ALTER TABLE cliente_saldos ALTER COLUMN pago_id DROP NOT NULL');
    await q.query('CREATE INDEX IF NOT EXISTS cliente_saldos_reembolso_idx ON cliente_saldos (reembolso_id)');
    await q.query(`DO $$ BEGIN
      ALTER TABLE cliente_saldos ADD CONSTRAINT cliente_saldos_origen_check
        CHECK (pago_id IS NOT NULL OR reembolso_id IS NOT NULL);
      EXCEPTION WHEN duplicate_object THEN NULL;
    END $$`);
  }

  async down() { /* Conserva los saldos parciales y su historial. */ }
}
