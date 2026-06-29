import { IsDateString, IsNumber, IsPositive } from 'class-validator';

export class AddVentaAdelantoCuotaDto {
  @IsNumber()
  @IsPositive()
  montoCuota: number;

  @IsDateString()
  fechaCuota: string;
}
