import { PartialType } from '@nestjs/mapped-types';
import { CreateGastoDto } from './create-gasto.dto';
import { IsOptional, IsString } from 'class-validator';

export class UpdateGastoDto extends PartialType(CreateGastoDto) {
  // Aceptar legacy detalleGusto para compatibilidad hacia notas (se vuelca a notas en el service)
  @IsOptional()
  @IsString()
  detalleGusto?: string | null;
}
