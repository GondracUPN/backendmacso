import { BadRequestException } from '@nestjs/common';

export function costoEnSoles(valor: { valorProducto: number; monedaCompra?: string }, tipoCambio: number): number {
  const pen = String(valor.monedaCompra || 'USD').toUpperCase() === 'PEN';
  if (!pen && (!Number.isFinite(tipoCambio) || tipoCambio <= 0)) throw new BadRequestException('Tipo de cambio inválido.');
  return Number((Number(valor.valorProducto) * (pen ? 1 : tipoCambio)).toFixed(2));
}
