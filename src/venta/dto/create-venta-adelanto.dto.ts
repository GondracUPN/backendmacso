import { IsDateString, IsInt, IsNumber, IsPositive } from 'class-validator';

export class CreateVentaAdelantoDto {
  @IsInt()
  productoId: number;

  @IsNumber()
  @IsPositive()
  montoAdelanto: number; // S/

  @IsDateString()
  fechaAdelanto: string; // YYYY-MM-DD

  @IsNumber()
  @IsPositive()
  montoVenta: number; // S/
}
