import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CreateProductoDto } from './create-producto.dto';

export class ProductoLoteDistribucionDto {
  @IsOptional()
  @IsString()
  vendedor?: string;

  @IsInt()
  @Min(1)
  @Max(100)
  cantidad: number;
}

export class CreateProductoLoteDto {
  @ValidateNested()
  @Type(() => CreateProductoDto)
  producto: CreateProductoDto;

  @IsInt()
  @Min(2)
  @Max(100)
  cantidad: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ProductoLoteDistribucionDto)
  distribucion: ProductoLoteDistribucionDto[];

  @IsOptional()
  @IsString()
  casillero?: string;

  @IsOptional()
  @IsBoolean()
  vincularTodos?: boolean;
}
