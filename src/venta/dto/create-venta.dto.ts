import {
  IsNumber,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsIn,
  Min,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SaleIncomePartDto {
  @IsIn(['direct', 'card', 'debt', 'cash'])
  type: 'direct' | 'card' | 'debt' | 'cash';

  @IsNumber()
  @Min(0.01)
  amount: number;
}

export class CreateVentaDto {
  @IsInt()
  productoId: number;

  @IsNumber()
  tipoCambio: number;

  @IsOptional()
  @IsNumber()
  tipoCambioGonzalo?: number;

  @IsOptional()
  @IsNumber()
  tipoCambioRenato?: number;

  @IsDateString()
  fechaVenta: string; // YYYY-MM-DD

  @IsNumber()
  precioVenta: number; // S/

  @IsOptional()
  @IsInt()
  @Min(1)
  cantidad?: number;

  @IsOptional()
  @IsIn(['unidad', 'mayor'])
  modalidad?: 'unidad' | 'mayor';

  @IsOptional()
  @IsIn(['bcp', 'interbank', 'bbva', 'bcp_amex', 'bcp_visa', 'visa_qore', 'io', 'saga'])
  incomeBank?: 'bcp' | 'interbank' | 'bbva' | 'bcp_amex' | 'bcp_visa' | 'visa_qore' | 'io' | 'saga';

  @IsOptional()
  @IsIn(['direct', 'card', 'debt'])
  incomePaymentType?: 'direct' | 'card' | 'debt';

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SaleIncomePartDto)
  incomeParts?: SaleIncomePartDto[];

  @IsOptional()
  @IsString()
  incomeSku?: string;

  @IsOptional()
  @IsString()
  vendedor?: string; // ✅ ahora permitido por el validador
}
