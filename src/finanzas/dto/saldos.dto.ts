import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';
export class ClienteComercialDto {
  @IsString() @Length(2, 120) nombre: string;
  @IsIn(['externo', 'propio', 'renato']) clase: 'externo' | 'propio' | 'renato';
  @IsBoolean() admiteSaldo: boolean;
}
export class AsignarClienteDto {
  @IsInt() @Min(1) clienteId: number;
}
export class GenerarSaldoDto {
  @IsOptional() @IsDateString() fecha?: string;
  @IsOptional() @IsString() @Length(3, 1000) motivo?: string;
}
export class AplicarSaldoDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) monto: number;
  @IsDateString() fecha: string;
  @IsString() @Length(8, 100) operacion: string;
  @IsBoolean() pagoAdicional: boolean;
  @IsOptional() @IsDateString() fechaPago?: string;
  @IsOptional() @IsInt() @Min(1) cuentaId?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) tipoCambioPagoAdicional?: number;
}
export class DevolverSaldoDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) monto: number;
  @IsDateString() fecha: string;
  @IsInt() @Min(1) cuentaId: number;
  @IsString() @Length(8, 100) operacion: string;
}

export class ResolverPedidoClienteDto {
  @IsOptional() @IsString() @Length(1, 80) vendedor?: string;
  @IsOptional() @IsInt() @Min(1) ventaId?: number;
}
