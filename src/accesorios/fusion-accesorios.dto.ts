import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, Max, Min } from 'class-validator';

export class FusionAccesoriosDto {
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(100) @ArrayUnique()
  @IsInt({ each: true }) @Min(1, { each: true }) @Max(2147483647, { each: true })
  productoIds: number[];
}
