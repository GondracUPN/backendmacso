import { ArrayMaxSize, ArrayUnique, IsArray, IsInt, Max, Min } from 'class-validator';
import { MAX_ACCESORIOS_INCLUIDOS } from '../accesorios-stock';

export class UpdateAccesoriosStockDto {
  @IsInt() @Min(0)
  revision: number;

  @IsArray() @ArrayMaxSize(MAX_ACCESORIOS_INCLUIDOS) @ArrayUnique()
  @IsInt({ each: true }) @Min(1, { each: true }) @Max(2147483647, { each: true })
  productoIds: number[];
}
