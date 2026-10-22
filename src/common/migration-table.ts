import { QueryRunner } from 'typeorm';

export const migrationSchema = (qr: QueryRunner): string =>
  (qr.connection.options as { schema?: string }).schema || 'public';

export const migrationTable = (qr: QueryRunner, name: string): string =>
  [migrationSchema(qr), name].map((part) => `"${part.replace(/"/g, '""')}"`).join('.');
