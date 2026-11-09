import { MigrationInterface, QueryRunner } from 'typeorm';
import { ensureSaldosClientesProtections } from '../db/saldos-clientes-schema';

export class ReclamoSaldoInmediato1794096000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE cliente_saldos ADD COLUMN IF NOT EXISTS anulada_at timestamptz');
    await q.query('ALTER TABLE reembolsos ADD COLUMN IF NOT EXISTS reversion_reclamo jsonb');
    await q.query('ALTER TABLE reembolsos DROP CONSTRAINT IF EXISTS chk_reembolso_estado');
    await q.query("ALTER TABLE reembolsos ADD CONSTRAINT chk_reembolso_estado CHECK (estado IN ('en_transito','incidencia','reclamo_abierto','aprobado','reembolso_parcial','recibido','rechazado','perdida_definitiva','anulado'))");
    await ensureSaldosClientesProtections(q);
  }

  async down(): Promise<void> {
    throw new Error('No se puede retirar el historial de anulaciones de reclamos y saldos.');
  }
}
