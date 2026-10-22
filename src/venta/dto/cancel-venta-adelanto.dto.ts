import {
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CancelVentaAdelantoDto {
  @IsOptional()
  @IsDateString()
  fechaDevolucion?: string;

  // Si no se indica, se devuelve todo lo adelantado.
  @IsOptional()
  @IsNumber()
  @Min(0)
  montoDevuelto?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  motivo?: string;

  @IsOptional()
  @IsInt()
  cuentaId?: number;
}
