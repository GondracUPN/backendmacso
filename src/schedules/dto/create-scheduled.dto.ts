import { IsIn, IsISO8601, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, MaxLength, Min } from 'class-validator';

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

  @IsNumber()
  @IsPositive()
  monto: number;

  @IsISO8601()
  nextDate: string; // fecha de inicio/proxima generación

  @IsOptional()
  @IsIn(['interbank', 'bcp_amex', 'bcp_visa', 'bbva', 'io', 'saga'])
  tarjeta?: string;

  @IsOptional()
  @IsIn(['interbank', 'bcp_amex', 'bcp_visa', 'bbva', 'io', 'saga'])
  tarjetaPago?: string;

  // para cuotas
  @IsOptional()
  @IsNumber()
  @Min(1)
  remaining?: number;
}

