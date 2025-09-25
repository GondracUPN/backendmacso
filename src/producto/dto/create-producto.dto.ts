import { IsString, IsOptional, IsBoolean, IsNumber, IsDateString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateProductoDetalleDto {
  @IsOptional() @IsString() gama?: string;
  @IsOptional() @IsString() procesador?: string;
  @IsOptional() @IsString() generacion?: string;
  @IsOptional() @IsString() modelo?: string;
  @IsOptional() @IsString() tamaño?: string;
  @IsOptional() @IsString() almacenamiento?: string;
  @IsOptional() @IsString() ram?: string;
  @IsOptional() @IsString() conexion?: string;
  @IsOptional() @IsString() descripcionOtro?: string;
}

export class CreateProductoValorDto {
  @IsNumber() valorProducto: number;
  @IsNumber() valorDec: number;
  @IsNumber() peso: number;
  @IsDateString() fechaCompra: string;
}

export class CreateProductoDto {
  @IsString() tipo: string;           // macbook, ipad, iphone, watch, otro
  @IsString() estado: string;         // nuevo, usado, roto
  @IsOptional() @IsBoolean() conCaja?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateProductoDetalleDto)
  detalle?: CreateProductoDetalleDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateProductoValorDto)
  valor?: CreateProductoValorDto;
}
