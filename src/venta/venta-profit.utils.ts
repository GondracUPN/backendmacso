export const calculateProfitPercentage = (
  profit: number,
  totalCost: number,
): number => +((Number(profit) / (Number(totalCost) || 1)) * 100).toFixed(3);
