import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class SickwCheckDto {
  @IsString()
  @MaxLength(32)
  @Matches(/^[A-Za-z0-9]+$/)
  identifier: string;

  @IsOptional()
  @IsIn(['sn', 'imei', 'imei2'])
  type?: 'sn' | 'imei' | 'imei2';
}
