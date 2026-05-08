import { IsNumber, IsOptional, IsString, Matches, Min } from 'class-validator';

export class UpsertGastoBudgetDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}$/)
  month: string;

  @IsNumber()
  @Min(0)
  amount: number;

  @IsOptional()
  @IsNumber()
  userId?: number;
}
