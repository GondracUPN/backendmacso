export type GroupBy = 'day' | 'month' | 'year';

export type ProfitInput = {
  fechaVenta: string;
  income: number;
  cost: number;
};

export type ProfitRow = {
  period: string;
  income: number;
  cost: number;
  profit: number;
  margin: number;
};

function normalizeDateString(dateStr?: string | null): string | null {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const parsed = new Date(s);
  if (isNaN(parsed.getTime())) return null;
  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, '0');
  const d = String(parsed.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseParts(dateStr: string): { y: number; m: number; d: number } | null {
  const parts = dateStr.split('-').map((v) => Number(v));
  if (parts.length !== 3) return null;
  const [y, m, d] = parts;
  if (!y || !m || !d) return null;
  return { y, m, d };
}

function formatYMD(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function periodKey(dateStr: string, groupBy: GroupBy): string | null {
  const norm = normalizeDateString(dateStr);
  if (!norm) return null;
  if (groupBy === 'day') return norm;
  if (groupBy === 'month') return norm.slice(0, 7);
  return norm.slice(0, 4);
}

export function listPeriods(from?: string, to?: string, groupBy: GroupBy = 'month'): string[] {
  const normFrom = normalizeDateString(from || '');
  const normTo = normalizeDateString(to || '');
  if (!normFrom || !normTo) return [];
  const start = parseParts(normFrom);
  const end = parseParts(normTo);
  if (!start || !end) return [];

  const periods: string[] = [];
  if (groupBy === 'day') {
    let curr = new Date(Date.UTC(start.y, start.m - 1, start.d));
    const endDate = new Date(Date.UTC(end.y, end.m - 1, end.d));
    while (curr <= endDate) {
      periods.push(formatYMD(curr.getUTCFullYear(), curr.getUTCMonth() + 1, curr.getUTCDate()));
      curr = new Date(curr.getTime() + 86400000);
    }
    return periods;
  }

  if (groupBy === 'month') {
    let y = start.y;
    let m = start.m;
    while (y < end.y || (y === end.y && m <= end.m)) {
      periods.push(`${y}-${String(m).padStart(2, '0')}`);
      m += 1;
      if (m > 12) {
        y += 1;
        m = 1;
      }
    }
    return periods;
  }

  for (let y = start.y; y <= end.y; y += 1) {
    periods.push(String(y));
  }
  return periods;
}

export function aggregateProfitByPeriod(
  rows: ProfitInput[],
  opts: { from?: string; to?: string; groupBy?: GroupBy },
): ProfitRow[] {
  const groupBy = (opts.groupBy || 'month') as GroupBy;
  let from = opts.from;
  let to = opts.to;

  if (!from || !to) {
    const dates = rows
      .map((r) => normalizeDateString(r.fechaVenta))
      .filter((d): d is string => !!d);
    if (!dates.length) return [];
    dates.sort();
    from = from || dates[0];
    to = to || dates[dates.length - 1];
  }

  const periods = listPeriods(from, to, groupBy);
  if (!periods.length) return [];

  const map = new Map<string, { income: number; cost: number }>();
  for (const row of rows) {
    const key = periodKey(row.fechaVenta, groupBy);
    if (!key) continue;
    const curr = map.get(key) || { income: 0, cost: 0 };
    curr.income += Number(row.income || 0);
    curr.cost += Number(row.cost || 0);
    map.set(key, curr);
  }

  return periods.map((period) => {
    const curr = map.get(period) || { income: 0, cost: 0 };
    const income = +curr.income.toFixed(2);
    const cost = +curr.cost.toFixed(2);
    const profit = +(income - cost).toFixed(2);
    const margin = income > 0 ? +((profit / income) * 100).toFixed(2) : 0;
    return { period, income, cost, profit, margin };
  });
}
