import { assertRequiredColumnsOrThrow } from './db-boot.guard';

describe('guard de columnas de arranque', () => {
  it('comprueba todas las tablas en una sola consulta', async () => {
    const query = jest.fn().mockResolvedValue([
      { table_name: 'venta', column_name: 'operacionHash' },
      { table_name: 'producto', column_name: 'archivadoAt' },
    ]);
    await assertRequiredColumnsOrThrow({ query } as any, 'tienda', JSON.stringify({
      venta: ['operacionHash'], producto: ['archivadoAt'],
    }));
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('detiene el arranque si faltan campos requeridos', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await expect(assertRequiredColumnsOrThrow({ query } as any, 'tienda', '{"venta":["operacionHash"]}'))
      .rejects.toThrow('venta.operacionHash');
  });
});
