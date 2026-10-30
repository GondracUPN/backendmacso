import { accessoryLotCost } from './accessory-cost';

it.each([
  ['PEN', 0, 20], ['PEN', 4, 24], ['USD', 0, 74], ['USD', 4, 78],
])('calcula lote simple %s con envío %s sin reutilizar una conversión anterior', (monedaCompra, costoEnvio, expected) => {
  expect(accessoryLotCost({ tipo: 'accesorios', soloInventario: true,
    valor: { valorProducto: 20, monedaCompra, costoEnvio, valorSoles: 999, costoTotal: 999 } } as any)).toBe(expected);
});

it('conserva el costo de compras con referencia y usa envío prorrateado en simples', () => {
  const lot: any = { tipo: 'accesorios', soloInventario: true,
    valor: { valorProducto: 20, monedaCompra: 'USD', costoEnvio: 10, costoEnvioProrrateado: 4, costoTotalProrrateado: 86 } };
  expect(accessoryLotCost(lot)).toBe(78);
  expect(accessoryLotCost({ ...lot, referenciaId: 55 })).toBe(86);
  expect(accessoryLotCost({ ...lot, soloInventario: false })).toBe(86);
});
