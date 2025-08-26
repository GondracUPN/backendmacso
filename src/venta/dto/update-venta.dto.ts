// src/venta/dto/update-venta.dto.ts
import { PartialType, OmitType } from '@nestjs/mapped-types';
import { CreateVentaDto } from './create-venta.dto';

// No permitimos cambiar productoId en el update.
export class UpdateVentaDto extends PartialType(
  OmitType(CreateVentaDto, ['productoId'] as const),
) {}
