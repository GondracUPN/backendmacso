import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Movimientos que no tienen otro registro de origen: transferencias entre cuentas
 * propias y ajustes manuales. Cobros, liquidaciones, gastos y reembolsos se leen de
 * sus propias tablas para no registrar el mismo dinero dos veces.
 */
export const TIPOS_MOVIMIENTO = ['transferencia', 'ajuste'] as const;
export type TipoMovimiento = (typeof TIPOS_MOVIMIENTO)[number];

@Entity('movimientos_financieros')
export class MovimientoFinanciero {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ type: 'date' })
  fecha: string;

  @Column({ type: 'varchar', length: 20 })
  tipo: TipoMovimiento;

  @Column({ name: 'cuenta_origen_id', type: 'int', nullable: true })
  cuentaOrigenId?: number | null;

  @Column({ name: 'cuenta_destino_id', type: 'int', nullable: true })
  cuentaDestinoId?: number | null;

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

  @Column({ name: 'monto_pen', type: 'numeric', precision: 12, scale: 2 })
  montoPen: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  metodo?: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  referencia?: string | null;

  @Column({ type: 'text', nullable: true })
  nota?: string | null;

  @Index({ unique: true })
  @Column({ name: 'idempotency_key', type: 'varchar', length: 120 })
  idempotencyKey: string;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy?: number | null;

  @Column({ name: 'anulado_at', type: 'timestamptz', nullable: true })
  anuladoAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
