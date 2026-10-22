import { IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Min } from 'class-validator';

export class DevolverVentaDto {
  @IsInt() @Min(1) cantidad: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) monto: number;
  @IsIn(['disponible', 'revision', 'averiado', 'baja']) destino: 'disponible' | 'revision' | 'averiado' | 'baja';
  @IsDateString() fecha: string;
  @IsString() @Length(3, 1000) motivo: string;
  @IsOptional() @IsInt() @Min(1) cuentaId?: number;
  @IsString() @Length(8, 100) operacionKey: string;
}

export class EliminarVentaDto {
  @IsString() @Length(3, 1000) motivo: string;
}
