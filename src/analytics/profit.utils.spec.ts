import { aggregateProfitByPeriod, listPeriods } from './profit.utils';

describe('profit.utils', () => {
  it('listPeriods fills missing days', () => {
    const out = listPeriods('2025-11-01', '2025-11-03', 'day');
    expect(out).toEqual(['2025-11-01', '2025-11-02', '2025-11-03']);
  });

  it('listPeriods fills missing months', () => {
    const out = listPeriods('2025-10-01', '2026-01-10', 'month');
    expect(out).toEqual(['2025-10', '2025-11', '2025-12', '2026-01']);
  });

  it('aggregateProfitByPeriod computes profit and margin', () => {
    const rows = [
      { fechaVenta: '2025-11-01', income: 100, cost: 70 },
      { fechaVenta: '2025-11-05', income: 50, cost: 20 },
      { fechaVenta: '2025-12-01', income: 10, cost: 5 },
    ];
    const out = aggregateProfitByPeriod(rows, {
      from: '2025-11-01',
      to: '2025-12-31',
      groupBy: 'month',
    });
    expect(out).toEqual([
      { period: '2025-11', income: 150, cost: 90, profit: 60, margin: 40 },
      { period: '2025-12', income: 10, cost: 5, profit: 5, margin: 50 },
    ]);
  });

  it('aggregateProfitByPeriod fills missing periods with zeros', () => {
    const rows = [{ fechaVenta: '2025-11-02', income: 100, cost: 25 }];
    const out = aggregateProfitByPeriod(rows, {
      from: '2025-11-01',
      to: '2025-11-03',
      groupBy: 'day',
    });
    expect(out).toEqual([
      { period: '2025-11-01', income: 0, cost: 0, profit: 0, margin: 0 },
      { period: '2025-11-02', income: 100, cost: 25, profit: 75, margin: 75 },
      { period: '2025-11-03', income: 0, cost: 0, profit: 0, margin: 0 },
    ]);
  });
});
