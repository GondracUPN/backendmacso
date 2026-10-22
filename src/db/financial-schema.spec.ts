import { DataSource } from 'typeorm';
import { ensureFinancialSchema } from './financial-schema';

describe('ajustes financieros de arranque', () => {
  const setup = (hasConciliacion = true) => {
    const qr = {
      connection: { options: { schema: 'tienda"uno' } },
      isTransactionActive: true,
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      getTable: jest.fn().mockResolvedValue({
        foreignKeys: [{ columnNames: ['productoId'], onDelete: 'RESTRICT' }],
      }),
      dropForeignKey: jest.fn(),
      query: jest.fn(async (sql: string, _parameters?: unknown[]) =>
        sql.includes('information_schema.columns') && hasConciliacion ? [{ exists: 1 }] : [],
      ),
    };
    const ds = { createQueryRunner: () => qr } as unknown as DataSource;
    return { qr, ds };
  };

  it('prepara las columnas faltantes y usa el schema configurado en una transaccion', async () => {
    const { qr, ds } = setup();
    await ensureFinancialSchema(ds);
    expect(qr.query).toHaveBeenNthCalledWith(1,
      "SELECT set_config('search_path', $1, true)", ['"tienda""uno"'],
    );
    const sql = qr.query.mock.calls.map(([statement]) => statement).join('\n');
    for (const column of ['operacionHash', 'archivadoAt', 'archivoMotivo', 'costoCompletadoTotal', 'scheduled_period', 'sale_cuenta_id']) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${column === 'scheduled_period' || column === 'sale_cuenta_id' ? column : `"${column}"`}`);
    }
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "venta_pagos"');
    expect(sql).toContain('"tienda""uno"."venta_devoluciones"');
    expect(qr.dropForeignKey).not.toHaveBeenCalled();
    expect(qr.commitTransaction).toHaveBeenCalledTimes(1);
    expect(qr.rollbackTransaction).not.toHaveBeenCalled();
    expect(qr.release).toHaveBeenCalledTimes(1);
  });

  it('conserva la conciliacion historica en arranques posteriores', async () => {
    const { qr, ds } = setup();
    await ensureFinancialSchema(ds);
    await ensureFinancialSchema(ds);
    const statements = qr.query.mock.calls.map(([sql]) => sql);
    expect(statements.some((sql) => sql.includes('UPDATE "venta"'))).toBe(false);
  });

  it('marca la conciliacion solo si la columna no existia', async () => {
    const { qr, ds } = setup(false);
    await ensureFinancialSchema(ds);
    expect(qr.query).toHaveBeenCalledWith(
      `UPDATE "venta" SET "conciliacionHistorica" = 'pendiente'`,
    );
  });

  it('revierte y propaga un fallo de DDL para detener el arranque', async () => {
    const { qr, ds } = setup();
    qr.query.mockRejectedValueOnce(new Error('permission denied'));
    await expect(ensureFinancialSchema(ds)).rejects.toThrow('permission denied');
    expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(qr.commitTransaction).not.toHaveBeenCalled();
    expect(qr.release).toHaveBeenCalledTimes(1);
  });
});
