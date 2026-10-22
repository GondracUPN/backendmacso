import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Reembolso } from './reembolso.entity';

export const TIPOS_EVENTO_REEMBOLSO = [
  'incidencia',
  'reclamo',
  'aprobado',
  'recibido',
  'rechazado',
  'perdida',
  'gasto_adicional',
  'nota',
] as const;
export type TipoEventoReembolso = (typeof TIPOS_EVENTO_REEMBOLSO)[number];

@Entity('reembolso_eventos')
export class ReembolsoEvento {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ name: 'reembolso_id', type: 'int' })
  reembolsoId: number;

  @ManyToOne(() => Reembolso, (r) => r.eventos, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'reembolso_id' })
  reembolso?: Reembolso;

  @Column({ type: 'varchar', length: 20 })
  tipo: TipoEventoReembolso;

  @Index()
  @Column({ type: 'date' })
  fecha: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  monto?: string | null;

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

  @Column({
    name: 'monto_pen',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
  })
  montoPen?: string | null;

  // Cuenta donde llegó el dinero; si es una tarjeta de crédito, reduce su deuda.
  @Column({ name: 'cuenta_id', type: 'int', nullable: true })
  cuentaId?: number | null;

  // Ingreso a crédito creado en Gastos para reflejar la devolución en la deuda de la tarjeta.
  @Column({ name: 'gasto_id', type: 'int', nullable: true })
  gastoId?: number | null;

  @Column({ type: 'text', nullable: true })
  nota?: string | null;

  @Index({ unique: true })
  @Column({ name: 'idempotency_key', type: 'varchar', length: 120 })
  idempotencyKey: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
