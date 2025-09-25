import { IsNumber, IsDateString, IsInt, IsOptional, IsString } from 'class-validator';

export class CreateVentaDto {
  @IsInt()
  productoId: number;

  @IsNumber()
  tipoCambio: number;

  @IsDateString()
  fechaVenta: string; // YYYY-MM-DD

  @IsNumber()
  precioVenta: number; // S/

  @IsOptional()
  @IsString()
  vendedor?: string;   // ✅ ahora permitido por el validador
}
