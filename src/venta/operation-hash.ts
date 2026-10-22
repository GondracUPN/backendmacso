import { createHash } from 'node:crypto';

export function operationHash(value: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort()
      .filter((key) => v[key] !== undefined && key !== 'operacionKey' && key !== 'idempotencyKey')
      .map((key) => [key, canonical(v[key])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
