import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

/** Zona a releer, en fracciones (0-1) de la imagen ya orientada según EXIF. */
export class OcrCropDto {
  @IsNumber()
  @Min(0)
  @Max(1)
  x!: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  y!: number;

  @IsNumber()
  @Min(0.005)
  @Max(1)
  width!: number;

  @IsNumber()
  @Min(0.005)
  @Max(1)
  height!: number;
}

export class VisionOcrDto {
  @IsOptional()
  @IsString()
  @MaxLength(14_000_000)
  imageBase64?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(1200)
  imageUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  mimeType?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => OcrCropDto)
  crop?: OcrCropDto;

  /** Identificador opaco del cliente; se devuelve tal cual para descartar respuestas obsoletas. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9:_-]{1,64}$/)
  requestToken?: string;
}
