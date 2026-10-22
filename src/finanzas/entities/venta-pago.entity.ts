import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { PagoLiquidacion } from './pago-liquidacion.entity';

export const METODOS_PAGO = [
  'efectivo',
  'transferencia',
  'yape',
  'plin',
  'tarjeta',
  'deposito',
  'x500',
  'otro',
] as const;
export type MetodoPago = (typeof METODOS_PAGO)[number];

/**
 * Estado del dinero de un pago concreto. El estado de cobro de la venta se calcula
 * a partir de todos sus pagos y nunca se guarda en un solo campo "pagado".
 */
export const ESTADOS_PAGO = [
  'disponible', // ya está en una cuenta propia disponible
  'pendiente_liquidacion', // pagado por el cliente, retenido por pasarela o tercero
  'parcialmente_liquidado',
  'liquidado',
  'devuelto',
  'disputado',
  'anulado',
] as const;
export type EstadoPago = (typeof ESTADOS_PAGO)[number];

export type OrigenPago =
  | 'manual'
  | 'ingreso_venta'
  | 'adelanto'
  | 'historico'
  | 'conciliacion';

@Entity('venta_pagos')
export class VentaPago {
  @PrimaryGeneratedColumn()
  id: number;

  // Sin FK: si una venta se elimina, el pago se conserva anulado para auditoría.
  @Index()
  @Column({ name: 'venta_id', type: 'int', nullable: true })
  ventaId?: number | null;

  @Index()
  @Column({ name: 'adelanto_id', type: 'int', nullable: true })
  adelantoId?: number | null;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  monto: string;

  @Column({ type: 'varchar', length: 3, default: 'PEN' })
  moneda: 'PEN' | 'USD';

  @Column({
    name: 'tipo_cambio',
    type: 'numeric',
    precision: 10,
    scale: 4,
    nullable: true,
  })
  tipoCambio?: string | null;

  // Importe aplicado al saldo de la venta en soles.
  @Column({ name: 'monto_pen', type: 'numeric', precision: 12, scale: 2 })
  montoPen: string;

  // Fecha en la que pagó el cliente. Solo es nula en conciliaciones históricas sin fecha conocida.
  @Index()
  @Column({ name: 'fecha_pago', type: 'date', nullable: true })
  fechaPago?: string | null;

  @Column({ type: 'varchar', length: 20 })
  metodo: MetodoPago;

  @Column({
    name: 'cuenta_origen',
    type: 'varchar',
    length: 80,
    nullable: true,
  })
  cuentaOrigen?: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  referencia?: string | null;

  @Column({ type: 'varchar', length: 30 })
  estado: EstadoPago;

  @Column({ name: 'requiere_liquidacion', type: 'boolean', default: false })
  requiereLiquidacion: boolean;

  @Column({
    name: 'comision_estimada',
    type: 'numeric',
    precision: 12,
    scale: 2,
    default: 0,
  })
  comisionEstimada: string;

  @Column({ name: 'fecha_liquidacion_estimada', type: 'date', nullable: true })
  fechaLiquidacionEstimada?: string | null;

  @Column({ name: 'cuenta_receptora_id', type: 'int', nullable: true })
  cuentaReceptoraId?: number | null;

  @Column({ name: 'es_adelanto', type: 'boolean', default: false })
  esAdelanto: boolean;

  @Column({ type: 'varchar', length: 20, default: 'manual' })
  origen: OrigenPago;

  // false = proviene de registros anteriores al sistema y aún no fue confirmado.
  @Column({ type: 'boolean', default: true })
  verificado: boolean;

  @Index()
  @Column({ name: 'gasto_id', type: 'int', nullable: true })
  gastoId?: number | null;

  @Index({ unique: true })
  @Column({ name: 'idempotency_key', type: 'varchar', length: 120 })
  idempotencyKey: string;

  @Column({ type: 'text', nullable: true })
  observacion?: string | null;

  @Column({ name: 'anulado_at', type: 'timestamptz', nullable: true })
  anuladoAt?: Date | null;

  @OneToMany(() => PagoLiquidacion, (l) => l.pago)
  liquidaciones?: PagoLiquidacion[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
