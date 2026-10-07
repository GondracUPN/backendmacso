import { IsDateString, IsIn, IsNumber, IsOptional, IsPositive } from 'class-validator';

export class AddVentaAdelantoCuotaDto {
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
