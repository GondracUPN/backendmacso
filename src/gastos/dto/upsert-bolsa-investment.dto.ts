import { IsDateString, IsNumber, IsOptional, IsString, Matches, Min } from 'class-validator';

export class UpsertBolsaInvestmentDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}$/)
  month: string;

  @IsNumber()
  @Min(0)
  amount: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  hapiAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  triiAmount?: number;

  @IsDateString()
  date: string;
}
