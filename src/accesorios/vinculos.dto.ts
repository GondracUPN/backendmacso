import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, Length, Min, ValidateNested } from 'class-validator';
import { ReferenciaDto } from './accesorios.dto';

export class AjusteVinculoDto {
  @IsInt() @Min(1) propuestaId: number;
  @IsOptional() @IsInt() @Min(1) referenciaId?: number;
  @IsOptional() @ValidateNested() @Type(() => ReferenciaDto) datosReferencia?: ReferenciaDto;
}
export class AplicarVinculosDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ArrayUnique() @IsInt({ each: true }) propuestaIds: number[];
  @IsString() @Length(8, 100) idempotencyKey: string;
  @IsOptional() @IsBoolean() parcial?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => AjusteVinculoDto) ajustes?: AjusteVinculoDto[];
}
export class DeshacerVinculosDto {
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ArrayUnique() @IsInt({ each: true }) productoIds?: number[];
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ArrayUnique() @IsInt({ each: true }) auditoriaIds?: number[];
  @IsOptional() @IsString() @Length(8, 100) idempotencyKey?: string;
}
export class RechazarVinculoDto { @IsOptional() @IsString() @Length(1, 1000) motivo?: string; }
export class CambioInformativoDto { @IsNumber({ maxDecimalPlaces: 6 }) @Min(0.0001) tipoCambioCompra: number; }
