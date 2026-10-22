import { DataSource } from 'typeorm';

export type DbBootInfo = {
  host: string;
  database: string;
  schema: string;
  user?: string;
  searchPath?: string;
};

type EnvLike = Record<string, string | undefined>;

const DEFAULT_REQUIRED_COLUMNS: Record<string, string[]> = {
  producto: ['accesorios', 'vendedor', 'archivadoAt'],
  tracking: ['estatus_esho'],
  venta: ['tipoCambioGonzalo', 'tipoCambioRenato', 'operacionHash', 'costoCompletadoTotal'],
};

const normalizeList = (raw?: string | null) =>
  String(raw || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const normalizeLowerList = (raw?: string | null) =>
  normalizeList(raw).map((part) => part.toLowerCase());

const resolveBoolean = (raw: string | undefined, fallback: boolean) => {
  if (raw == null || raw === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

export const shouldRunDbGuard = (nodeEnv: string, rawFlag?: string) => {
  const isProd = ['production', 'prod'].includes(String(nodeEnv || '').trim().toLowerCase());
  return resolveBoolean(rawFlag, isProd);
};

const parseRequiredColumns = (raw?: string | null) => {
  if (!raw) return DEFAULT_REQUIRED_COLUMNS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      '[DB_GUARD] REQUIRED_DB_COLUMNS debe ser JSON valido. Ejemplo: {"producto":["accesorios"]}',
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[DB_GUARD] REQUIRED_DB_COLUMNS debe ser un objeto { tabla: [columnas] }.');
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  const normalized: Record<string, string[]> = {};

  for (const [table, columns] of entries) {
    if (!Array.isArray(columns)) {
      throw new Error(`[DB_GUARD] REQUIRED_DB_COLUMNS.${table} debe ser un arreglo.`);
    }
    const clean = columns
      .map((column) => String(column || '').trim())
      .filter(Boolean);
    if (!clean.length) continue;
    normalized[table] = clean;
  }

  return Object.keys(normalized).length ? normalized : DEFAULT_REQUIRED_COLUMNS;
};

export const assertExpectedDbTargetOrThrow = (dbInfo: DbBootInfo, env: EnvLike) => {
  const expectedHosts = normalizeLowerList(env.EXPECTED_DB_HOSTS || env.EXPECTED_DB_HOST);
  const expectedDatabases = normalizeLowerList(env.EXPECTED_DB_NAMES || env.EXPECTED_DB_NAME);
  const expectedSchemas = normalizeLowerList(env.EXPECTED_DB_SCHEMAS || env.EXPECTED_DB_SCHEMA);

  const actualHost = String(dbInfo.host || '').trim().toLowerCase();
  const actualDatabase = String(dbInfo.database || '').trim().toLowerCase();
  const actualSchema = String(dbInfo.schema || '').trim().toLowerCase();

  const errors: string[] = [];

  if (expectedHosts.length && !expectedHosts.includes(actualHost)) {
    errors.push(`host actual "${dbInfo.host}" no coincide con EXPECTED_DB_HOST(S)=${expectedHosts.join(', ')}`);
  }
  if (expectedDatabases.length && !expectedDatabases.includes(actualDatabase)) {
    errors.push(
      `database actual "${dbInfo.database}" no coincide con EXPECTED_DB_NAME(S)=${expectedDatabases.join(', ')}`,
    );
  }
  if (expectedSchemas.length && !expectedSchemas.includes(actualSchema)) {
    errors.push(`schema actual "${dbInfo.schema}" no coincide con EXPECTED_DB_SCHEMA(S)=${expectedSchemas.join(', ')}`);
  }

  if (errors.length) {
    throw new Error(`[DB_GUARD] Base de datos inesperada detectada. ${errors.join(' | ')}`);
  }
};

export const assertRequiredColumnsOrThrow = async (
  dataSource: DataSource,
  schema: string,
  rawRequiredColumns?: string,
) => {
  const requiredColumns = parseRequiredColumns(rawRequiredColumns);
  const missing: string[] = [];

  const rows = await dataSource.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = ANY($2::text[])`,
    [schema, Object.keys(requiredColumns)],
  );
  const currentColumns = new Set(rows.map((row: { table_name: string; column_name: string }) =>
    `${row.table_name}.${row.column_name}`));
  for (const [table, columns] of Object.entries(requiredColumns)) {
    for (const column of columns) {
      if (!currentColumns.has(`${table}.${column}`)) missing.push(`${table}.${column}`);
    }
  }

  if (missing.length) {
    throw new Error(
      `[DB_GUARD] Faltan columnas requeridas en schema "${schema}": ${missing.join(', ')}`,
    );
  }
};
