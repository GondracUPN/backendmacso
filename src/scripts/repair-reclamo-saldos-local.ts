import 'reflect-metadata';
import { config } from 'dotenv';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { shouldSynchronizeLocalDatabase } from '../db/local-schema';
import { repararSaldosReclamoSinCobro } from '../finanzas/reclamo-saldos-reparacion';
import { reabrirProductoConReclamosAnulados } from '../finanzas/reclamo-producto-disponibilidad';

config({ path: join(process.cwd(), '.env'), quiet: true });
async function main() {
  if (!shouldSynchronizeLocalDatabase(process.env.NODE_ENV, process.env.DB_SYNC))
    throw new Error('Esta reparación solo se permite en la BD local de pruebas.');
  const ds = new DataSource({ type: 'postgres', url: process.env.DATABASE_URL,
    schema: process.env.DB_SCHEMA || 'public', synchronize: false,
    entities: [join(__dirname, '../**/*.entity.ts')], logging: false });
  try {
    await ds.initialize();
    const q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      const productos = await q.query('SELECT DISTINCT producto_id FROM reembolsos ORDER BY producto_id');
      const retirados: Array<{id: number; original: string}> = [];
      const reabiertos: Array<{id: number}> = [];
      for (const p of productos) {
        retirados.push(...await repararSaldosReclamoSinCobro(q.manager, p.producto_id));
        reabiertos.push(...await reabrirProductoConReclamosAnulados(q.manager, p.producto_id));
      }
      if (process.argv.includes('--apply')) await q.commitTransaction();
      else await q.rollbackTransaction();
      console.log(JSON.stringify({ aplicado: process.argv.includes('--apply'), saldos: retirados.map(s => ({ id: s.id, importe: s.original })), productosReabiertos: reabiertos.map(p => p.id) }));
    } catch (e) { if (q.isTransactionActive) await q.rollbackTransaction(); throw e; }
    finally { await q.release(); }
  } finally { if (ds.isInitialized) await ds.destroy(); }
}
main().catch(() => { console.error('No se aplicó la reparación local de saldos.'); process.exitCode = 1; });
