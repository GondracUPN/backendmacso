import { IsString } from 'class-validator';

export class UploadInventarioFotoDto {
  @IsString()
  dataUrl: string;
}
