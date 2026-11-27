import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateVentaDto } from './create-venta.dto';

export class UpdateVentaDto extends PartialType(OmitType(CreateVentaDto, ['accesoriosStockIds', 'accesoriosStockRevision'] as const)) {}
