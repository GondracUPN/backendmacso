import {
  IsString,
  IsOptional,
  IsNumber,
  IsDateString,
  ValidateNested,
  IsArray,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateProductoDetalleDto {
  @IsOptional() @IsString() gama?: string;
  @IsOptional() @IsString() procesador?: string;
  @IsOptional() @IsString() generacion?: string;
  @IsOptional() @IsString() numero?: string;
  @IsOptional() @IsString() modelo?: string;
  // Usar 'tamano' (ASCII) para evitar errores de encoding
  @IsOptional() @IsString() tamano?: string;
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
  @IsString() tipo: string; // macbook, ipad, iphone, watch, otro
  @IsString() estado: string; // nuevo, usado, roto
  // Nuevo: accesorios para usado; para 'nuevo' se fuerza Caja internamente
  @IsOptional() @IsArray() accesorios?: string[]; // ['Caja','Cubo','Cable'] o ['Todos']

  @IsOptional()
  @IsBoolean()
  facturaDecSubida?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateProductoDetalleDto)
  detalle?: CreateProductoDetalleDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateProductoValorDto)
  valor?: CreateProductoValorDto;

  // Opcional: vincular este producto con otro para prorratear envío
  @IsOptional()
  @IsNumber()
  vincularCon?: number;
}
