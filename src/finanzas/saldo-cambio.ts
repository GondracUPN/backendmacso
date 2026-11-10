import { BadRequestException } from '@nestjs/common';

/** Cuando el saldo no supera el dinero nuevo, ambos importes fijan el cambio de la venta. */
export function cambioVentaConSaldo(partes: Array<{ cents: number; tipoCambio: unknown }>, adicionalCents: number, tipoCambioAdicional?: unknown) {
  const saldoCents = partes.reduce((n, p) => n + p.cents, 0);
  if (adicionalCents > 0 && adicionalCents >= saldoCents) {
    if (!(Number(tipoCambioAdicional) > 0)) throw new BadRequestException('Indica el tipo de cambio del pago adicional.');
    return cambioSaldoHistorico([...partes, { cents: adicionalCents, tipoCambio: tipoCambioAdicional }]);
  }
  return cambioSaldoHistorico(partes);
}
/** Equivalente histórico: PEN total / USD históricos, sin redondear cada tramo a centavos. */
export function cambioSaldoHistorico(
  partes: Array<{ cents: number; tipoCambio: unknown }>,
) {
  const div = (n: bigint, d: bigint) => (n + d / 2n) / d;
  let pen = 0n,
    usd = 0n;
  for (const p of partes) {
    const rate = Math.round(Number(p.tipoCambio) * 10000);
    if (
      !Number.isSafeInteger(p.cents) ||
      p.cents <= 0 ||
      !Number.isSafeInteger(rate) ||
      rate <= 0
    )
      throw new BadRequestException(
        'Falta el tipo de cambio histórico del saldo.',
      );
    pen += BigInt(p.cents);
    usd += div(BigInt(p.cents) * 100000000n, BigInt(rate));
  }
  if (!pen || !usd)
    throw new BadRequestException(
      'No hay saldo histórico para calcular el cambio.',
    );
  return {
    tipoCambio: Number(div(pen * 100000000n, usd)) / 10000,
    equivalenteUsd: Number(usd) / 1000000,
  };
}
