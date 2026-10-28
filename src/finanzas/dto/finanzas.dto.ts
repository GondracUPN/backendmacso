import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Length,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { METODOS_PAGO, MetodoPago } from '../entities/venta-pago.entity';
import {
  TIPOS_EVENTO_PAGO,
  TipoEventoPago,
} from '../entities/pago-liquidacion.entity';
import { TIPOS_CUENTA, TipoCuenta } from '../entities/cuenta-financiera.entity';
import {
  TIPOS_EVENTO_REEMBOLSO,
  TipoEventoReembolso,
} from '../entities/reembolso-evento.entity';

export const CLASIFICACIONES_GASTO = [
  'costo_inventario',
  'costo_directo',
  'comision_venta',
  'gasto_operativo',
  'gasto_financiero',
  'perdida',
  'movimiento_deuda',
  'transferencia',
  'ajuste_devolucion',
  'personal',
] as const;
export type ClasificacionGasto = (typeof CLASIFICACIONES_GASTO)[number];

export class RegistrarPagoDto {
  @IsOptional() @IsInt() ventaId?: number;
  @IsOptional() @IsInt() adelantoId?: number;
  @IsNumber() @IsPositive() monto: number;
  @IsOptional() @IsIn(['PEN', 'USD']) moneda?: 'PEN' | 'USD';
  @ValidateIf((o) => o.moneda === 'USD')
  @IsNumber()
  @IsPositive()
  tipoCambio?: number;
  @IsDateString() fechaPago: string;
  @IsIn(METODOS_PAGO as unknown as string[]) metodo: MetodoPago;
  @IsOptional() @IsInt() cuentaReceptoraId?: number;
  @IsOptional() @IsString() @MaxLength(80) cuentaOrigen?: string;
  @IsOptional() @IsString() @MaxLength(120) referencia?: string;
  @IsOptional() @IsNumber() @Min(0) comisionEstimada?: number;
  @IsOptional() @IsDateString() fechaLiquidacionEstimada?: string;
  @IsOptional() @IsString() @MaxLength(1000) observacion?: string;
  @IsString() @Length(8, 120) idempotencyKey: string;
}

export class RegistrarEventoPagoDto {
  @IsIn(TIPOS_EVENTO_PAGO as unknown as string[]) tipo: TipoEventoPago;
  @IsDateString() fecha: string;
  @IsNumber() @IsPositive() montoBruto: number;
  @IsOptional() @IsNumber() @Min(0) comision?: number;
  @IsOptional() @IsInt() cuentaId?: number;
  @IsOptional() @IsString() @MaxLength(120) referencia?: string;
  @IsOptional() @IsString() @MaxLength(1000) nota?: string;
  @IsString() @Length(8, 120) idempotencyKey: string;
}

export class AnularDto {
  @IsString() @Length(3, 500) motivo: string;
}

export class CuentaDto {
  @IsString() @Length(2, 40) codigo: string;
  @IsString() @Length(2, 80) nombre: string;
  @IsIn(TIPOS_CUENTA as unknown as string[]) tipo: TipoCuenta;
  @IsOptional() @IsIn(['PEN', 'USD']) moneda?: 'PEN' | 'USD';
  @IsOptional() @IsString() @MaxLength(32) legacyCodigo?: string;
}

export class ActualizarCuentaDto {
  @IsOptional() @IsString() @Length(2, 80) nombre?: string;
  @IsOptional() @IsBoolean() activo?: boolean;
  @IsOptional() @IsString() @MaxLength(32) legacyCodigo?: string;
}

export class MovimientoDto {
  @IsIn(['transferencia', 'ajuste']) tipo: 'transferencia' | 'ajuste';
  @IsDateString() fecha: string;
  @IsOptional() @IsInt() cuentaOrigenId?: number;
  @IsOptional() @IsInt() cuentaDestinoId?: number;
  @IsNumber() @IsPositive() monto: number;
  @IsOptional() @IsIn(['PEN', 'USD']) moneda?: 'PEN' | 'USD';
  @ValidateIf((o) => o.moneda === 'USD')
  @IsNumber()
  @IsPositive()
  tipoCambio?: number;
  @IsOptional() @IsString() @MaxLength(20) metodo?: string;
  @IsOptional() @IsString() @MaxLength(120) referencia?: string;
  @IsOptional() @IsString() @MaxLength(1000) nota?: string;
  @IsString() @Length(8, 120) idempotencyKey: string;
}

export class CrearReembolsoDto {
  @IsInt() productoId: number;
  @IsOptional()
  @IsIn(['en_transito', 'incidencia', 'reclamo_abierto'])
  estado?: 'en_transito' | 'incidencia' | 'reclamo_abierto';
  @IsOptional() @IsIn(['PEN', 'USD']) moneda?: 'PEN' | 'USD';
  @IsOptional() @IsNumber() @Min(0) costoOriginal?: number; // en soles; por defecto el costo del producto
  @IsOptional() @IsNumber() @Min(0) gastosAdicionales?: number; // en soles
  @IsOptional() @IsNumber() @Min(0) montoReclamado?: number; // en la moneda del reclamo
  @IsOptional() @IsInt() cuentaDevolucionId?: number;
  @IsOptional() @IsDateString() fechaIncidencia?: string;
  @IsOptional() @IsString() @MaxLength(120) referencia?: string;
  @IsOptional() @IsString() @MaxLength(1000) motivo?: string;
}

export class EventoReembolsoDto {
  @IsIn(TIPOS_EVENTO_REEMBOLSO as unknown as string[])
  tipo: TipoEventoReembolso;
  @IsDateString() fecha: string;
  @IsOptional() @IsNumber() @Min(0) monto?: number;
  @IsOptional() @IsIn(['PEN', 'USD']) moneda?: 'PEN' | 'USD';
  @ValidateIf((o) => o.moneda === 'USD' && o.monto != null)
  @IsNumber()
  @IsPositive()
  tipoCambio?: number;
  @IsOptional() @IsInt() cuentaId?: number;
  @IsOptional() @IsString() @MaxLength(1000) nota?: string;
  @IsString() @Length(8, 120) idempotencyKey: string;
}

export class CerrarProductoDto {
  @IsIn(['perdido', 'cancelado', 'no_comercializable', 'reabrir'])
  motivo: 'perdido' | 'cancelado' | 'no_comercializable' | 'reabrir';
}

export class ConciliarVentaDto {
  // confirmar_registros: los ingresos registrados en Gastos son correctos.
  // con_fecha: registrar el saldo como cobrado en una fecha conocida.
  // sin_fecha: confirmar que se cobró, sin fecha conocida (no entra al flujo mensual).
  // pendiente_real: la venta realmente tiene saldo por cobrar.
  // vincular_ingresos: el cobro ya está registrado en Gastos como ingreso suelto; se enlaza sin copiarlo.
  @IsIn([
    'confirmar_registros',
    'con_fecha',
    'sin_fecha',
    'pendiente_real',
    'vincular_ingresos',
  ])
  modo:
    | 'confirmar_registros'
    | 'con_fecha'
    | 'sin_fecha'
    | 'pendiente_real'
    | 'vincular_ingresos';
  @ValidateIf((o) => o.modo === 'vincular_ingresos')
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsInt({ each: true })
  gastoIds?: number[];
  // Registrar el cobro aunque existan ingresos sueltos parecidos en Gastos.
  @IsOptional()
  @IsBoolean()
  forzar?: boolean;
  @ValidateIf((o) => o.modo === 'con_fecha') @IsDateString() fecha?: string;
  @IsOptional() @IsInt() cuentaId?: number;
  @IsOptional() @IsIn(METODOS_PAGO as unknown as string[]) metodo?: MetodoPago;
  @IsOptional() @IsString() @MaxLength(1000) nota?: string;
}

export class ConciliarLoteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  ventaIds: number[];
}

export class ClasificarGastoDto {
  @IsOptional()
  @IsIn([...CLASIFICACIONES_GASTO, null] as unknown as string[])
  clasificacionFinanciera?: ClasificacionGasto | null;
  @IsOptional() @IsInt() ventaVinculadaId?: number | null;
  @IsOptional() @IsInt() productoVinculadoId?: number | null;
}

export class ItemVentaRapidaDto {
  @IsOptional() @IsString() @Length(64, 64) cotizacionToken?: string;
  @IsOptional() @IsInt() productoId?: number;
  @ValidateIf((o) => !o.productoId) @IsString() @Length(2, 120) nombre?: string;
  @IsInt() @Min(1) cantidad: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) precioUnitario: number;
  // Vacío = costo desconocido: la utilidad queda pendiente (nunca se asume cero).
  @IsOptional() @IsNumber() @Min(0) costoUnitario?: number | null;
}

export class VentaRapidaDto {
  @IsDateString() fecha: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ItemVentaRapidaDto)
  items: ItemVentaRapidaDto[];
  @IsIn(METODOS_PAGO as unknown as string[]) metodo: MetodoPago;
  @IsIn(['pagado', 'pendiente']) estadoCobro: 'pagado' | 'pendiente';
  @IsOptional() @IsInt() cuentaReceptoraId?: number;
  @IsOptional() @IsNumber() @IsPositive() tipoCambio?: number;
  @IsOptional() @IsString() @MaxLength(80) vendedor?: string;
  @IsOptional() @IsInt() ventaRelacionadaId?: number; // combinar con una MacBook u otro equipo
  @IsOptional() @IsString() @MaxLength(120) referencia?: string;
  @IsString() @Length(8, 100) idempotencyKey: string;
}

export class PrecioPactadoDto {
  @IsNumber()
  @Min(0)
  precioLista: number;
}

export class CompletarCostoDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) costoTotal: number;
  @IsString() @Length(3, 1000) documento: string;
}
