import { IsIn, IsISO8601, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, MaxLength, Min, Max, IsInt } from 'class-validator';

export class CreateScheduledDto {
  @IsIn(['debito', 'credito'])
  metodoPago: 'debito' | 'credito';

  @IsIn(['recurrente', 'cuotas'])
  tipo: 'recurrente' | 'cuotas';

  @IsString()
  @MaxLength(140)
  @IsNotEmpty()
  concepto: string;

  @IsIn(['PEN', 'USD'])
  moneda: 'PEN' | 'USD';

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(99999999.99)
  monto: number;

  @IsISO8601()
  nextDate: string; // fecha de inicio/proxima generación

  @IsOptional() @IsInt() @Min(1) @Max(31)
  anchorDay?: number;

  @IsOptional()
  @IsIn(['bcp', 'interbank', 'bcp_amex', 'bcp_visa', 'visa_qore', 'bbva', 'io', 'saga'])
  tarjeta?: string;

  @IsOptional()
  @IsIn(['bcp', 'interbank', 'bcp_amex', 'bcp_visa', 'visa_qore', 'bbva', 'io', 'saga'])
  tarjetaPago?: string;

  // para cuotas
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(32767)
  remaining?: number;
}

