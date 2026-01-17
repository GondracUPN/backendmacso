import { IsDateString, IsInt, IsNumber } from 'class-validator';

export class CreateVentaAdelantoDto {
  @IsInt()
  productoId: number;

  @IsNumber()
  montoAdelanto: number; // S/

  @IsDateString()
  fechaAdelanto: string; // YYYY-MM-DD

  @IsNumber()
  montoVenta: number; // S/
}
