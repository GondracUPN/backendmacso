import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

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
}
