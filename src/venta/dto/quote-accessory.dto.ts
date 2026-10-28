import { IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class QuoteAccessoryDto {
  @IsInt() @Min(1) productoId: number;
  @IsInt() @Min(1) cantidad: number;
  @IsOptional() @IsString() comprador?: string;
  @IsOptional() @IsInt() @Min(1) loteInicialId?: number;
  @IsOptional() @IsNumber() @Min(0) precioUnitario?: number;
}
