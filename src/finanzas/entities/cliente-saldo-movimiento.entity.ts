import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { ClienteSaldo } from './cliente-saldo.entity';
import { Venta } from '../../venta/venta.entity';
import { VentaPago } from './venta-pago.entity';
import { MovimientoFinanciero } from './movimiento-financiero.entity';
@Entity('cliente_saldo_movimientos')
@Unique('cliente_saldo_movimientos_saldo_id_operacion_key', [
  'saldoId',
  'operacion',
])
@Check(
  'cliente_saldo_movimientos_tipo_check',
  "tipo IN ('aplicacion','devolucion')",
)
@Check('cliente_saldo_movimientos_monto_check', 'monto > 0')
@Check(
  'cliente_saldo_movimientos_check',
  "(tipo = 'aplicacion' AND venta_id IS NOT NULL AND pago_id IS NOT NULL) OR (tipo = 'devolucion' AND movimiento_id IS NOT NULL)",
)
export class ClienteSaldoMovimiento {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'saldo_id', type: 'int', nullable: false }) saldoId: number;
  @ManyToOne(() => ClienteSaldo, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({
    name: 'saldo_id',
    foreignKeyConstraintName: 'cliente_saldo_movimientos_saldo_id_fkey',
  })
  saldoIdRelacion: ClienteSaldo;
  @Column({ name: 'venta_id', type: 'int', nullable: true }) ventaId?:
    | number
    | null;
  @ManyToOne(() => Venta, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({
    name: 'venta_id',
    foreignKeyConstraintName: 'cliente_saldo_movimientos_venta_id_fkey',
  })
  ventaIdRelacion?: Venta;
  @Column({ name: 'pago_id', type: 'int', nullable: true }) pagoId?:
    | number
    | null;
  @ManyToOne(() => VentaPago, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({
    name: 'pago_id',
    foreignKeyConstraintName: 'cliente_saldo_movimientos_pago_id_fkey',
  })
  pagoIdRelacion?: VentaPago;
  @Column({ name: 'movimiento_id', type: 'int', nullable: true })
  movimientoId?: number | null;
  @ManyToOne(() => MovimientoFinanciero, {
    onDelete: 'RESTRICT',
    nullable: true,
  })
  @JoinColumn({
    name: 'movimiento_id',
    foreignKeyConstraintName: 'cliente_saldo_movimientos_movimiento_id_fkey',
  })
  movimientoIdRelacion?: MovimientoFinanciero;
  @Column({ type: 'varchar', length: 15 }) tipo: 'aplicacion' | 'devolucion';
  @Column({ type: 'numeric', precision: 12, scale: 2 }) monto: string;
  @Column({ type: 'date' }) fecha: string;
  @Column({ type: 'varchar', length: 120 }) operacion: string;
  @Column({ name: 'operacion_hash', type: 'varchar', length: 64 })
  operacionHash: string;
  @Column({ name: 'creado_por', type: 'int' }) creadoPor: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
