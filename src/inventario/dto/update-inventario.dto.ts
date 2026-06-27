import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumber,
  IsIn,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateInventarioDto {
  @IsOptional() @IsBoolean() enAlmacen?: boolean;
  @IsOptional() @IsString() @MaxLength(80) color?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(100000) ciclosBateria?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(100) saludBateria?: number | null;
  @IsOptional() @IsNumber() @Min(0) primerPrecioSoles?: number | null;
  @IsOptional() @IsDateString() garantiaHasta?: string | null;
  @IsOptional() @IsBoolean() tieneGarantia?: boolean;
  @IsOptional() @IsIn(['limitada', 'applecare']) tipoGarantia?: string | null;
  @IsOptional() @IsString() @MaxLength(180) garantiaDetalle?: string | null;
  @IsOptional() @IsString() @MaxLength(120) serial?: string | null;
  @IsOptional() @IsString() @MaxLength(40) imei?: string | null;
  @IsOptional() @IsString() @MaxLength(40) imei2?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) accesorios?: string[];
  @IsOptional() @IsString() @MaxLength(3000) observaciones?: string | null;
  @IsOptional() @IsBoolean() fotosTomadas?: boolean;
  @IsOptional() @IsBoolean() marketplaceSubido?: boolean;
}
