import { IsDateString, IsNumber, IsString, Matches, Min } from 'class-validator';

export class UpsertBolsaInvestmentDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}$/)
  month: string;

  @IsNumber()
  @Min(0)
  amount: number;

  @IsDateString()
  date: string;
}
