import { AnalyticsService } from './analytics.service';
import { Producto } from '../producto/producto.entity';
import { Venta } from '../venta/venta.entity';

const product = (id: number, purchaseDate: string, cost: number, options: Partial<Producto> = {}) => ({
  id, tipo: 'macbook', estado: 'nuevo', vendedor: 'Gonzalo',
  stockInicial: 1, stockActual: 1,
  valor: { fechaCompra: purchaseDate, costoTotalProrrateado: cost },
  detalle: { gama: 'Air', procesador: 'M2' }, tracking: [], ...options,
}) as Producto;

describe('financialDashboard', () => {
  const service = new AnalyticsService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

  it('separa compras, costo vendido y stock, incluso entre meses y lotes', async () => {
    const products = [
      product(1, '2026-01-10', 100),
      product(2, '2026-02-10', 80),
      product(3, '2026-01-03', 90, { tipo: 'accesorios', stockInicial: 3, stockActual: 2 }),
    ];
    const ventas = [
      { id: 10, productoId: 1, producto: products[0], fechaVenta: '2026-02-15', precioVenta: 150, cantidad: 1 },
      { id: 11, productoId: 3, producto: products[2], fechaVenta: '2026-02-16', precioVenta: 50, cantidad: 1, distribucionStock: [{ productoId: 3, cantidad: 1 }] },
    ] as Venta[];
    jest.spyOn(service as any, 'getAnalyticsUniverseCached').mockResolvedValue({ productos: products, ventas });
    const result = await service.financialDashboard({ from: '2026-02-01', to: '2026-02-28' });
    expect(result.summary).toEqual(expect.objectContaining({
      capitalInvested: 270, purchaseCapitalInPeriod: 80, inventoryCapital: 140, recoveredCapital: 130,
      income: 200, cost: 130, grossProfit: 70, margin: 35,
    }));
    expect(result.categories.find((row) => row.category === 'accesorios')).toEqual(expect.objectContaining({ sold: 1, cost: 30, grossProfit: 20 }));
  });

  it('cuenta fechas Date de la base de datos y mantiene el capital acumulado fuera del período', async () => {
    const january = product(7, '2026-01-10', 100, { valor: { fechaCompra: new Date('2026-01-10T00:00:00.000Z'), costoTotalProrrateado: 100 } as any });
    const february = product(8, '2026-02-10', 80, { valor: { fechaCompra: new Date('2026-02-10T00:00:00.000Z'), costoTotalProrrateado: 80 } as any });
    jest.spyOn(service as any, 'getAnalyticsUniverseCached').mockResolvedValue({ productos: [january, february], ventas: [] });

    const februaryDashboard = await service.financialDashboard({ from: '2026-02-01', to: '2026-02-28' });
    expect(februaryDashboard.summary).toEqual(expect.objectContaining({ capitalInvested: 180, purchaseCapitalInPeriod: 80 }));
    expect(februaryDashboard.evolution).toEqual([expect.objectContaining({ period: '2026-02', purchases: 80 })]);
    expect(februaryDashboard.purchases.map((row) => row.purchaseDate)).toEqual(['2026-01-10', '2026-02-10']);

    const marchDashboard = await service.financialDashboard({ from: '2026-03-01', to: '2026-03-31' });
    expect(marchDashboard.summary).toEqual(expect.objectContaining({ capitalInvested: 180, purchaseCapitalInPeriod: 0 }));
  });

  it('reparte ventas conjuntas y no inventa utilidad cuando falta costo', async () => {
    const p = product(5, '2026-01-01', 100, { vendedor: 'Ambos' });
    const missing = product(6, '2026-01-01', 0, { vendedor: 'Ambos', valor: null as any });
    const ventas = [
      { id: 20, productoId: 5, producto: p, vendedor: 'ambos', fechaVenta: '2026-02-01', precioVenta: 200, tipoCambio: 3.7 },
      { id: 21, productoId: 6, producto: missing, vendedor: 'ambos', fechaVenta: '2026-02-02', precioVenta: 40, tipoCambio: 3.7 },
    ] as Venta[];
    jest.spyOn(service as any, 'getAnalyticsUniverseCached').mockResolvedValue({ productos: [p, missing], ventas });
    const result = await service.financialDashboard({ from: '2026-02-01', to: '2026-02-28', vendedor: 'Gonzalo' });
    expect(result.summary.income).toBe(120);
    expect(result.summary.cost).toBeNull();
    expect(result.summary.grossProfit).toBeNull();
    expect(result.summary.missingCosts).toBe(1);
  });
});
