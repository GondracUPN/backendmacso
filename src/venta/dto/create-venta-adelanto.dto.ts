import { IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsPositive } from 'class-validator';

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

  @IsOptional()
  @IsIn(['bcp', 'interbank', 'bbva'])
  incomeBank?: 'bcp' | 'interbank' | 'bbva';

  @IsOptional()
  @IsIn(['direct', 'card'])
  incomePaymentType?: 'direct' | 'card';
}
