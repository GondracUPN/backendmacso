import { IsDateString, IsNumber } from 'class-validator';

export class CompleteVentaAdelantoDto {
  @IsDateString()
  fechaVenta: string; // YYYY-MM-DD

  @IsNumber()
  tipoCambio: number;
}
