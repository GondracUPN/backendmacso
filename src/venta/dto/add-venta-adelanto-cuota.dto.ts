import { IsDateString, IsIn, IsNumber, IsOptional, IsPositive, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CerrarVentaCuotaDto {
  @IsDateString()
  fechaVenta: string;

  @IsNumber()
  @IsPositive()
  tipoCambio: number;
}

export class AddVentaAdelantoCuotaDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => CerrarVentaCuotaDto)
  cerrarVenta?: CerrarVentaCuotaDto;

  @IsNumber()
  @IsPositive()
  montoCuota: number;

  @IsDateString()
  fechaCuota: string;

  @IsOptional()
  @IsIn(['bcp', 'interbank', 'bbva'])
  incomeBank?: 'bcp' | 'interbank' | 'bbva';

  @IsOptional()
  @IsIn(['direct', 'card'])
  incomePaymentType?: 'direct' | 'card';
}
