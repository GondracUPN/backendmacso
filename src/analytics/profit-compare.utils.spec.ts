import { buildInsights, computeDeltas, computePreviousRange } from './profit-compare.utils';

describe('profit-compare.utils', () => {
  it('computePreviousRange returns same-length previous range', () => {
    const out = computePreviousRange('2026-01-01', '2026-01-31');
    expect(out).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('computePreviousRange returns full previous month for month-aligned range', () => {
    const out = computePreviousRange('2025-11-01', '2025-11-30');
    expect(out).toEqual({ from: '2025-10-01', to: '2025-10-31' });
  });

  it('computePreviousRange keeps day-based range for partial months', () => {
    const out = computePreviousRange('2026-02-10', '2026-02-20');
    expect(out).toEqual({ from: '2026-01-30', to: '2026-02-09' });
  });

  it('computeDeltas handles division by zero', () => {
    const curr = { income: 100, cost: 50, profit: 50, margin: 50, orders: 0, avgTicket: 0 };
    const prev = { income: 0, cost: 0, profit: 0, margin: 0, orders: 0, avgTicket: 0 };
    const out = computeDeltas(curr, prev);
    expect(out.incomePct).toBeNull();
    expect(out.profitPct).toBeNull();
    expect(out.ordersPct).toBe(0);
  });

  it('buildInsights generates minimum insights', () => {
    const delta = computeDeltas(
      { income: 200, cost: 100, profit: 100, margin: 50, orders: 4, avgTicket: 50 },
      { income: 100, cost: 90, profit: 10, margin: 10, orders: 2, avgTicket: 50 },
    );
    const insights = buildInsights({
      current: { income: 200, cost: 100, profit: 100, margin: 50, orders: 4, avgTicket: 50 },
      previous: { income: 100, cost: 90, profit: 10, margin: 10, orders: 2, avgTicket: 50 },
      delta,
      topProducts: [
        { name: 'MacBook Pro', profit: 80 },
        { name: 'iPhone', profit: 20 },
      ],
    });
    expect(insights.length).toBeGreaterThanOrEqual(5);
  });
});
