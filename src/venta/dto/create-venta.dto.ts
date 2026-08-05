import {
  IsNumber,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsIn,
} from 'class-validator';

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
  @IsIn(['bcp', 'interbank', 'bbva'])
  incomeBank?: 'bcp' | 'interbank' | 'bbva';

  @IsOptional()
  @IsString()
  vendedor?: string; // ✅ ahora permitido por el validador
}
