import { financialTotals, saleAmounts } from './financial-core';
import { Producto } from '../producto/producto.entity';
import { Venta } from '../venta/venta.entity';

const product = (id: number, cost: number, initial = 1, stock = initial) => ({
  id, tipo: 'accesorios', stockInicial: initial, stockActual: stock,
  valor: { costoTotalProrrateado: cost },
}) as Producto;

describe('costo histórico de ventas', () => {
  it('atribuye a cada venta solo las unidades consumidas de cada lote', () => {
    const products = new Map([[1, product(1, 100, 5)], [2, product(2, 90, 3)]]);
    const sale = { productoId: 1, precioVenta: 110, cantidad: 2, distribucionStock: [
      { productoId: 1, cantidad: 1 }, { productoId: 2, cantidad: 1 },
    ] } as Venta;
    expect(saleAmounts(sale, products)).toEqual({ income: 110, cost: 50, profit: 60, margin: 54.55, markup: 120 });
    expect(financialTotals([saleAmounts(sale, products)])).toEqual({ income: 110, cost: 50, grossProfit: 60, margin: 54.55, markup: 120, missingCosts: 0 });
  });

  it('no inventa ganancia cuando falta el costo', () => {
    const sale = { productoId: 3, precioVenta: 80, cantidad: 1 } as Venta;
    const amounts = saleAmounts(sale, new Map([[3, { id: 3, tipo: 'accesorios', stockInicial: 1 } as Producto]]));
    expect(amounts.cost).toBeNull();
    expect(financialTotals([amounts]).grossProfit).toBeNull();
  });

  it('conserva el costo de la venta aunque cambie el costo actual del lote', () => {
    const sale = { productoId: 1, precioVenta: 75, cantidad: 1, distribucionStock: [{ productoId: 1, cantidad: 1, costoUnitario: 20 }] } as Venta;
    expect(saleAmounts(sale, new Map([[1, product(1, 300, 5)]])).cost).toBe(20);
  });
});
