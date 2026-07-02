import { calculateProfitPercentage } from './venta-profit.utils';

describe('calculateProfitPercentage', () => {
  it('calcula el porcentaje sobre el costo total, sin descontar adelantos', () => {
    const totalCost = 1400;
    const salePrice = 2000;
    const profit = salePrice - totalCost;

    expect(calculateProfitPercentage(profit, totalCost)).toBe(42.857);
  });
});
