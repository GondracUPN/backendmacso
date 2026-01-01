import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
  IsBoolean,
} from 'class-validator';

const CARD_TYPES = [
  'interbank',
  'bcp_amex',
  'bcp_visa',
  'bbva',
  'io',
  'saga',
] as const;
type CardType = (typeof CARD_TYPES)[number];

export class CreateGastoDto {
  @IsString()
  @MaxLength(140)
  @IsNotEmpty()
  concepto: string; // comida | gusto | ingreso | pago_tarjeta | inversion | pago_envios | ...

  // Requerido si concepto es "compras cuotas"/"cuotas"
  @ValidateIf((o) => {
    const c = String(o.concepto || '').toLowerCase();
    return c === 'compras cuotas' || c === 'cuotas' || c === 'compras_cuotas';
  })
  @IsInt()
  @Min(1)
  @IsOptional()
  cuotasMeses?: number;

  @IsIn(['PEN', 'USD'])
  moneda: 'PEN' | 'USD';

  @IsNumber()
  @IsPositive()
  monto: number;

  @IsISO8601()
  fecha: string; // YYYY-MM-DD

  @IsIn(['debito', 'credito'])
  metodoPago: 'debito' | 'credito';

  // Tarjeta usada si metodoPago === 'credito'
  @ValidateIf((o) => o.metodoPago === 'credito')
  @IsIn(CARD_TYPES as any)
  @IsOptional()
  tarjeta?: CardType;

  // Tarjeta a la que se paga si metodoPago === 'debito' y concepto === 'pago_tarjeta'
  @ValidateIf(
    (o) =>
      o.metodoPago === 'debito' &&
      String(o.concepto || '').toLowerCase() === 'pago_tarjeta',
  )
  @IsIn(CARD_TYPES as any)
  @IsOptional()
  tarjetaPago?: CardType;

  @ValidateIf((o) => String(o.concepto || '').toLowerCase() === 'gusto')
  @IsString()
  @IsNotEmpty()
  notas?: string | null;

  // Opcionales para flujos con conversión de moneda (débito pagando USD con PEN, etc.)
  @IsOptional()
  @IsNumber()
  @IsPositive()
  tipoCambioDia?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  montoUsdAplicado?: number;

  // Objetivo del pago en flujos de débito (para indicar a qué moneda aplica)
  @IsOptional()
  @IsIn(['PEN', 'USD'])
  pagoObjetivo?: 'PEN' | 'USD';

  // Equivalente en soles calculado en el cliente (opcional)
  @IsOptional()
  @IsNumber()
  @IsPositive()
  montoPenEquivalente?: number;

  // Bandera opcional enviada por el modal de crédito (aceptada, no procesada aquí)
  @IsOptional()
  @IsBoolean()
  recurrente?: boolean;
}
