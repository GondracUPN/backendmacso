import { IsNumber, IsDateString, IsInt } from 'class-validator';

export class CreateVentaDto {
  @IsInt()
  productoId: number;

  @IsNumber()
  tipoCambio: number;

  @IsDateString()
  fechaVenta: string; // ISO date (YYYY-MM-DD)

  @IsNumber()
  precioVenta: number; // S/

  
  vendedor?: string;

}
