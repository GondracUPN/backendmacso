import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { PartialType } from '@nestjs/mapped-types';

export class ReferenciaDto {
  @IsString() @Length(1, 100) categoria: string;
  @IsOptional() @IsString() @MaxLength(100) marca?: string;
  @IsString() @Length(1, 180) modelo: string;
  @IsOptional() @IsString() @MaxLength(100) generacion?: string;
  @IsOptional() @IsString() @MaxLength(250) variante?: string;
  @IsIn(['nuevo', 'usado', 'open_box', 'reacondicionado', 'roto']) estado: string;
  @IsIn(['original', 'fake', 'compatible']) originalidad: string;
  @IsOptional() @IsString() @MaxLength(2000) compatibilidad?: string;
  @IsOptional() @IsString() @MaxLength(2048) fotoUrl?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) precioPublicadoSoles?: number | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) precioMinimoSoles?: number | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) precioMayoristaSoles?: number | null;
  @IsOptional() @IsInt() @Min(1) cantidadMinimaMayorista?: number | null;
  @IsOptional() @IsBoolean() activo?: boolean;
}
export class EditReferenciaDto extends PartialType(ReferenciaDto) {}
export class LineaIngresoDto {
  @IsInt() @Min(1) cantidad: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) costoUnitario: number;
}
export class IngresoAccesorioDto {
  @IsString() @Length(8, 100) idempotencyKey: string;
  @IsOptional() @IsInt() @Min(1) referenciaId?: number;
  @IsOptional() @ValidateNested() @Type(() => ReferenciaDto) referencia?: ReferenciaDto;
  @IsIn(['Gonzalo', 'Renato', 'ambos']) comprador: string;
  @IsDateString() fechaCompra: string;
  @IsIn(['local', 'importada']) tipo: 'local' | 'importada';
  @IsIn(['PEN', 'USD']) moneda: 'PEN' | 'USD';
  @ValidateIf((row) => row.moneda === 'USD') @IsNumber() @Min(0.0001) tipoCambioCompra?: number;
  @ValidateIf((row) => row.tipo === 'importada') @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) costoLogistica?: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => LineaIngresoDto) lineas: LineaIngresoDto[];
}
