import { DataSource } from 'typeorm';
import { ensureSaldosClientesProtections } from './saldos-clientes-schema';
/** Desarrollo local usa synchronize contra BD de pruebas. Producción nunca sincroniza. */
export function shouldSynchronizeLocalDatabase(
  nodeEnv = '',
  flag?: string,
): boolean {
  if (['production', 'prod'].includes(nodeEnv.trim().toLowerCase()))
    return false;
  return (
    flag == null || flag.trim() === '' || flag.trim().toLowerCase() === 'true'
  );
}
/** Después de synchronize: añade únicamente protecciones SQL no expresables como entidades. */
export async function prepareLocalDatabase(
  dataSource: DataSource,
): Promise<void> {
  if (!dataSource.options.synchronize) return;
  const q = dataSource.createQueryRunner();
  try {
    await q.connect();
    await q.startTransaction();
    const schema =
      (dataSource.options as { schema?: string }).schema || 'public';
    await q.query("SELECT set_config('search_path',$1,true)", [
      '"' + schema.replace(/"/g, '""') + '"',
    ]);
    await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      schema + ':local-schema',
    ]);
    await ensureSaldosClientesProtections(q);
    await q.commitTransaction();
  } catch (error) {
    if (q.isTransactionActive) await q.rollbackTransaction();
    throw error;
  } finally {
    await q.release();
  }
}
