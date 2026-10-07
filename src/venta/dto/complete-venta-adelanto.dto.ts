import { IsArray, IsDateString, IsIn, IsNumber, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { SaleIncomePartDto } from './create-venta.dto';

export class CompleteVentaAdelantoDto {
  @IsDateString()
  fechaVenta: string; // YYYY-MM-DD

  @IsNumber()
  tipoCambio: number;

  @IsOptional()
  @IsIn(['bcp', 'interbank', 'bbva'])
  incomeBank?: 'bcp' | 'interbank' | 'bbva';

  @IsOptional()
  @IsIn(['direct', 'card'])
  incomePaymentType?: 'direct' | 'card';

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SaleIncomePartDto)
  incomeParts?: SaleIncomePartDto[];
}
