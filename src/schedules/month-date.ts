export function addMonth(dateStr: string, anchorDay = Number(dateStr.slice(8, 10))): string {
  const [year, month] = dateStr.slice(0, 10).split('-').map(Number);
  const first = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(Math.max(1, anchorDay), lastDay));
  return first.toISOString().slice(0, 10);
}
