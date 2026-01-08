export type CompareMetric = {
  income: number;
  cost: number;
  profit: number;
  margin: number;
  orders?: number;
  avgTicket?: number;
};

export type CompareDelta = {
  incomeAbs: number;
  incomePct: number | null;
  costAbs: number;
  costPct: number | null;
  profitAbs: number;
  profitPct: number | null;
  marginPp: number;
  ordersAbs: number;
  ordersPct: number | null;
  avgTicketAbs: number;
  avgTicketPct: number | null;
};

export type Insight = { level: 'success' | 'warning' | 'info'; text: string };

const toUtcDate = (d: string) => {
  const [y, m, day] = d.split('-').map((v) => Number(v));
  return new Date(Date.UTC(y, m - 1, day));
};

const toUtcParts = (d: string) => {
  const [y, m, day] = d.split('-').map((v) => Number(v));
  return { y, m, day };
};

const lastDayOfMonthUtc = (year: number, month1to12: number) =>
  new Date(Date.UTC(year, month1to12, 0)).getUTCDate();

const formatYmd = (year: number, month1to12: number, day: number) =>
  `${year}-${String(month1to12).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

const monthIndexToYearMonth = (idx: number) => {
  let year = Math.floor(idx / 12);
  let month0 = idx % 12;
  if (month0 < 0) {
    year -= 1;
    month0 += 12;
  }
  return { year, month1to12: month0 + 1 };
};

export function computePreviousRange(from: string, to: string) {
  const start = toUtcDate(from);
  const end = toUtcDate(to);
  const startParts = toUtcParts(from);
  const endParts = toUtcParts(to);
  const startMonthIndex = startParts.y * 12 + (startParts.m - 1);
  const endMonthIndex = endParts.y * 12 + (endParts.m - 1);
  const isFullMonthRange =
    startParts.day === 1 &&
    endParts.day === lastDayOfMonthUtc(endParts.y, endParts.m) &&
    startMonthIndex <= endMonthIndex;

  if (isFullMonthRange) {
    const months = endMonthIndex - startMonthIndex + 1;
    const prevFromIdx = startMonthIndex - months;
    const prevToIdx = startMonthIndex - 1;
    const prevFrom = monthIndexToYearMonth(prevFromIdx);
    const prevTo = monthIndexToYearMonth(prevToIdx);
    return {
      from: formatYmd(prevFrom.year, prevFrom.month1to12, 1),
      to: formatYmd(prevTo.year, prevTo.month1to12, lastDayOfMonthUtc(prevTo.year, prevTo.month1to12)),
    };
  }

  const dayMs = 86400000;
  const days = Math.round((end.getTime() - start.getTime()) / dayMs) + 1;
  const prevEnd = new Date(start.getTime() - dayMs);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * dayMs);
  const format = (dt: Date) =>
    `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  return { from: format(prevStart), to: format(prevEnd) };
}

const safePct = (curr: number, prev: number) => {
  if (prev === 0) return curr === 0 ? 0 : null;
  return +(((curr - prev) / prev) * 100).toFixed(2);
};

export function computeDeltas(current: CompareMetric, previous: CompareMetric): CompareDelta {
  const incomeAbs = +(current.income - previous.income).toFixed(2);
  const costAbs = +(current.cost - previous.cost).toFixed(2);
  const profitAbs = +(current.profit - previous.profit).toFixed(2);
  const marginPp = +(current.margin - previous.margin).toFixed(2);
  const ordersCurr = Number(current.orders || 0);
  const ordersPrev = Number(previous.orders || 0);
  const avgCurr = Number(current.avgTicket || 0);
  const avgPrev = Number(previous.avgTicket || 0);

  return {
    incomeAbs,
    incomePct: safePct(current.income, previous.income),
    costAbs,
    costPct: safePct(current.cost, previous.cost),
    profitAbs,
    profitPct: safePct(current.profit, previous.profit),
    marginPp,
    ordersAbs: ordersCurr - ordersPrev,
    ordersPct: safePct(ordersCurr, ordersPrev),
    avgTicketAbs: +(avgCurr - avgPrev).toFixed(2),
    avgTicketPct: safePct(avgCurr, avgPrev),
  };
}

export function buildInsights(params: {
  current: CompareMetric;
  previous: CompareMetric;
  delta: CompareDelta;
  topProducts?: { name: string; profit: number }[];
}): Insight[] {
  const { current, delta, topProducts = [] } = params;
  const insights: Insight[] = [];
  const profitPct = delta.profitPct;
  if (profitPct != null) {
    insights.push({
      level: profitPct >= 0 ? 'success' : 'warning',
      text: `La ganancia ${profitPct >= 0 ? 'subió' : 'bajó'} ${Math.abs(profitPct)}% vs el período anterior.`,
    });
  }

  if (delta.marginPp !== 0) {
    insights.push({
      level: delta.marginPp >= 0 ? 'success' : 'warning',
      text: `El margen ${delta.marginPp >= 0 ? 'subió' : 'bajó'} ${Math.abs(delta.marginPp)} pp.`,
    });
  }

  if (delta.costPct != null && delta.incomePct != null) {
    if (delta.costPct > delta.incomePct) {
      insights.push({ level: 'warning', text: 'Los costos crecieron más rápido que los ingresos.' });
    } else if (delta.costPct < delta.incomePct) {
      insights.push({ level: 'success', text: 'Los ingresos crecieron más rápido que los costos.' });
    }
  }

  if (current.orders != null && delta.ordersPct != null) {
    insights.push({
      level: delta.ordersPct >= 0 ? 'success' : 'warning',
      text: `Las ventas totales ${delta.ordersPct >= 0 ? 'subieron' : 'bajaron'} ${Math.abs(delta.ordersPct)}%.`,
    });
  }

  if (current.avgTicket != null && delta.avgTicketPct != null) {
    insights.push({
      level: delta.avgTicketPct >= 0 ? 'success' : 'warning',
      text: `El ticket promedio ${delta.avgTicketPct >= 0 ? 'subió' : 'bajó'} ${Math.abs(delta.avgTicketPct)}%.`,
    });
  }

  if (topProducts.length) {
    const totalProfit = topProducts.reduce((s, p) => s + p.profit, 0);
    const top3 = topProducts.slice(0, 3);
    const top3Profit = top3.reduce((s, p) => s + p.profit, 0);
    if (totalProfit > 0 && top3.length) {
      const share = +((top3Profit / totalProfit) * 100).toFixed(2);
      insights.push({
        level: 'info',
        text: `El ${share}% de la ganancia proviene del Top ${top3.length} productos.`,
      });
    }
    const top = topProducts[0];
    insights.push({
      level: 'info',
      text: `Producto ${top.name} fue el que más aportó a la ganancia.`,
    });
  }

  if (!current.orders && insights.length < 2) {
    insights.push({ level: 'info', text: 'No hubo ventas en el período actual.' });
  }

  return insights.slice(0, 7);
}
