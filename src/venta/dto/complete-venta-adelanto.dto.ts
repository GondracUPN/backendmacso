import { IsArray, IsDateString, IsIn, IsNumber, IsOptional, ValidateNested, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { PickType } from '@nestjs/mapped-types';
import { CreateVentaDto, SaleIncomePartDto } from './create-venta.dto';

export class CompleteVentaAdelantoDto extends PickType(CreateVentaDto, ['accesoriosStockIds', 'accesoriosStockRevision'] as const) {
  @IsDateString()
  fechaVenta: string; // YYYY-MM-DD

  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(1000)
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
