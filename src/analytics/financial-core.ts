import { Producto } from '../producto/producto.entity';
import { Venta } from '../venta/venta.entity';

const money = (value: unknown) => Number(value ?? 0);
export const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function productCost(product: Producto | null | undefined): number | null {
  const value = product?.valor;
  if (!value) return null;
  const direct = value.costoTotalProrrateado ?? value.costoTotal;
  if (direct != null && Number.isFinite(Number(direct))) return money(direct);
  if (value.valorSoles != null) return money(value.valorSoles) + money(value.costoEnvioProrrateado ?? value.costoEnvio);
  return null;
}

export function saleCost(sale: Venta, products: Map<number, Producto>): number | null {
  const product = products.get(Number(sale.productoId)) || sale.producto;
  if (!product) return null;
  if (String(product.tipo).toLowerCase() !== 'accesorios') {
    const savedProfit = sale.ganancia == null ? NaN : Number(sale.ganancia);
    if (Number.isFinite(savedProfit)) return roundMoney(Number(sale.precioVenta || 0) - savedProfit);
    return productCost(product);
  }
  const distribution = sale.distribucionStock?.length
    ? sale.distribucionStock
    : [{ productoId: sale.productoId, cantidad: sale.cantidad || 1 }];
  let total = 0;
  for (const row of distribution) {
    if (row.costoUnitario != null && Number.isFinite(Number(row.costoUnitario))) {
      total += Number(row.costoUnitario) * Number(row.cantidad || 0);
      continue;
    }
    const lot = products.get(Number(row.productoId));
    const cost = productCost(lot);
    if (cost == null || !Number.isFinite(cost)) return null;
    total += cost * Number(row.cantidad || 0) / Math.max(1, Number(lot?.stockInicial || 1));
  }
  return roundMoney(total);
}

export function saleAmounts(sale: Venta, products: Map<number, Producto>) {
  const income = roundMoney(money(sale.precioVenta));
  const cost = saleCost(sale, products);
  const profit = cost == null ? null : roundMoney(income - cost);
  return {
    income,
    cost,
    profit,
    margin: profit != null && income > 0 ? roundMoney(profit / income * 100) : null,
    markup: profit != null && cost != null && cost > 0 ? roundMoney(profit / cost * 100) : null,
  };
}

export function financialTotals(rows: Array<{ income: number; cost: number | null }>) {
  const income = roundMoney(rows.reduce((sum, row) => sum + row.income, 0));
  const missingCosts = rows.filter((row) => row.cost == null).length;
  const cost = missingCosts ? null : roundMoney(rows.reduce((sum, row) => sum + Number(row.cost), 0));
  const grossProfit = cost == null ? null : roundMoney(income - cost);
  return {
    income,
    cost,
    grossProfit,
    margin: grossProfit != null && income > 0 ? roundMoney(grossProfit / income * 100) : null,
    markup: grossProfit != null && cost != null && cost > 0 ? roundMoney(grossProfit / cost * 100) : null,
    missingCosts,
  };
}
