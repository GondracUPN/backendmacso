import {
  IsNumber,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsIn,
  Min,
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
  @IsInt()
  @Min(1)
  cantidad?: number;

  @IsOptional()
  @IsIn(['unidad', 'mayor'])
  modalidad?: 'unidad' | 'mayor';

  @IsOptional()
  @IsIn(['bcp', 'interbank', 'bbva'])
  incomeBank?: 'bcp' | 'interbank' | 'bbva';

  @IsOptional()
  @IsString()
  vendedor?: string; // ✅ ahora permitido por el validador
}
