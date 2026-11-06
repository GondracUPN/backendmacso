import 'reflect-metadata';
import { config } from 'dotenv';
import { join } from 'path';
import { DataSource } from 'typeorm';
import {
  prepareLocalDatabase,
  shouldSynchronizeLocalDatabase,
} from '../db/local-schema';
config({ path: join(process.cwd(), '.env') });
async function main() {
  if (
    !shouldSynchronizeLocalDatabase(process.env.NODE_ENV, process.env.DB_SYNC)
  )
    throw new Error(
      'Sincronización local desactivada. Nunca se ejecuta en producción.',
    );
  const ds = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    schema: process.env.DB_SCHEMA || 'public',
    synchronize: true,
    entities: [join(__dirname, '../**/*.entity.ts')],
    logging: false,
  });
  try {
    await ds.initialize();
    await prepareLocalDatabase(ds);
    const schema = (ds.options as { schema?: string }).schema || 'public';
    const rows = await ds.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name=ANY($2::text[]) ORDER BY table_name',
      [
        schema,
        ['clientes_comerciales', 'cliente_saldos', 'cliente_saldo_movimientos'],
      ],
    );
    console.log(
      '[DB_SYNC] BD local de pruebas sincronizada. Tablas de clientes y saldos:',
      rows.map((r) => r.table_name).join(', '),
    );
  } finally {
    if (ds.isInitialized) await ds.destroy();
  }
}
main().catch(() => {
  console.error(
    '[DB_SYNC] Falló la preparación de la BD local. No se imprimen datos de conexión.',
  );
  process.exitCode = 1;
});
