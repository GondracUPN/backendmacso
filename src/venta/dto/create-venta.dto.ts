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
  Length,
  Max,
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
  @IsOptional() @IsString() @Length(64, 64)
  cotizacionToken?: string;
  @IsOptional() @IsString() @Length(8, 100)
  operacionKey?: string;

  @IsInt()
  productoId: number;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001) @Max(1000)
  tipoCambio: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001) @Max(1000)
  tipoCambioGonzalo?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001) @Max(1000)
  tipoCambioRenato?: number;

  @IsDateString()
  fechaVenta: string; // YYYY-MM-DD

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01) @Max(99999999.99)
  precioVenta: number; // S/

  @IsOptional() @IsInt() @Min(1)
  incomeAccountId?: number;

  @IsOptional() @IsIn(['efectivo', 'transferencia', 'yape', 'plin', 'tarjeta', 'deposito', 'x500', 'otro'])
  incomeMethod?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  cantidad?: number;

  @IsOptional()
  @IsIn(['unidad', 'mayor'])
  modalidad?: 'unidad' | 'mayor';

  @IsOptional()
  @IsInt()
  @Min(1)
  loteInicialId?: number;

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

  // — Datos financieros opcionales —
  @IsOptional()
  @IsNumber()
  @Min(0)
  precioLista?: number; // precio pactado antes de descuentos

  @IsOptional()
  @IsNumber()
  @Min(0)
  descuento?: number;

  @IsOptional()
  @IsString()
  grupoOperacion?: string;
}
