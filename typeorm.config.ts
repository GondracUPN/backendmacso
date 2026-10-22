import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config as dotenv } from 'dotenv';
import { join } from 'path';

dotenv();

const env = (process.env.NODE_ENV || '').toLowerCase();
const isProd = env === 'production' || env === 'prod';
const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  // Not throwing here to keep CLI usable in local edits, but typeorm will fail anyway
  // eslint-disable-next-line no-console
  console.warn('DATABASE_URL is not set in environment');
}

export default new DataSource({
  type: 'postgres',
  url: dbUrl,
  ssl: isProd ? { rejectUnauthorized: false } : false,
  extra: { max: 10 },
  schema: process.env.DB_SCHEMA || 'public',
  logging: process.env.DB_LOG === 'true' || !isProd,
  entities: [
    // When running via ts-node
    join(__dirname, 'src/**/*.entity.{ts,js}'),
    // Fallback when compiled
    join(__dirname, '**/*.entity.{ts,js}'),
  ],
  // Cada migracion transaccional se confirma por separado; los indices concurrentes
  // declaran transaction=false y se ejecutan fuera de una transaccion.
  migrations: [join(__dirname, 'src/migrations/*.{ts,js}')],
  migrationsTransactionMode: 'each',
  migrationsTableName: 'typeorm_migrations',
});
