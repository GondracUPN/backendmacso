// src/tracking/dto/create-tracking.dto.ts
import {
  IsOptional,
  IsEnum,
  IsString,
  IsDateString,
  IsInt,
} from 'class-validator';

export class CreateTrackingDto {
  @IsInt()
  productoId: number;

  @IsOptional()
  @IsString()
  trackingUsa?: string;

  @IsOptional()
  @IsString()
  transportista?: string;

  @IsOptional()
  @IsString()
  casillero?: string;

  @IsOptional()
  @IsString()
  trackingEshop?: string;

  @IsOptional()
  @IsDateString()
  fechaRecepcion?: string;

  @IsOptional()
  @IsDateString()
  fechaRecogido?: string;

  @IsOptional()
  @IsEnum([
    'comprado_sin_tracking',
    'comprado_en_camino',
    'en_eshopex',
    'recogido',
  ])
  estado?:
    | 'comprado_sin_tracking'
    | 'comprado_en_camino'
    | 'en_eshopex'
    | 'recogido';
}
