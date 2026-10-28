import { FinanzasService } from './finanzas.service';

test('ofrece stock por código y comprador, precios guardados y ningún falso costo del primer lote', async () => {
  const query = jest.fn(async (_sql: string) => [
    { id: 1, codigo: 8, vendedor: 'Gonzalo', stockActual: 2, nombre: 'Cable', primerPrecioSoles: 25, ultimoPrecioSoles: 18 },
    { id: 2, codigo: 8, vendedor: 'Gonzalo', stockActual: 3, nombre: 'Cable' },
    { id: 3, codigo: 8, vendedor: 'Renato', stockActual: 9, nombre: 'Cable' },
  ]);
  const groups = await FinanzasService.prototype.accesoriosDisponibles.call({ dataSource: { query } });
  expect(groups).toEqual([
    expect.objectContaining({ productoId: 1, comprador: 'Gonzalo', stock: 5, precioPublicado: 25, precioMinimo: 18 }),
    expect.objectContaining({ productoId: 3, comprador: 'Renato', stock: 9 }),
  ]);
  expect(groups.every((row) => !('costoUnitario' in row))).toBe(true);
  expect(query.mock.calls[0][0]).toContain('p."archivadoAt" IS NULL');
});

test('agrupa por referencia aun con códigos distintos y recupera el precio de un lote agotado sin mezclar comprador', async () => {
  const query = jest.fn(async () => [
    { id: 1, codigo: 8, referenciaId: 20, vendedor: 'Gonzalo', stockActual: 0, nombre: 'Cable', primerPrecioSoles: 25, updatedAt: '2026-10-01' },
    { id: 2, codigo: 99, referenciaId: 20, vendedor: 'Gonzalo', stockActual: 5, nombre: 'Cable', updatedAt: '2026-10-20' },
    { id: 3, codigo: 99, referenciaId: 20, vendedor: 'Renato', stockActual: 9, nombre: 'Cable', primerPrecioSoles: 99 },
  ]);
  const groups = await FinanzasService.prototype.accesoriosDisponibles.call({ dataSource: { query } });
  expect(groups).toHaveLength(2);
  expect(groups.find((row) => row.comprador === 'Gonzalo')).toMatchObject({ referenciaId: 20, stock: 5, precioPublicado: 25 });
  expect(groups.find((row) => row.comprador === 'Renato')).toMatchObject({ stock: 9, precioPublicado: 99 });
});
