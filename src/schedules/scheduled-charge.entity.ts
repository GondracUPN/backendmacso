import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('scheduled_charges')
export class ScheduledCharge {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ name: 'user_id' })
  userId: number;

  @Column({ type: 'varchar', length: 10 })
  metodoPago: 'debito' | 'credito';

  @Column({ type: 'varchar', length: 24 })
  tipo: 'recurrente' | 'cuotas';

  @Column({ type: 'varchar', length: 140 })
  concepto: string; // normalizado

  @Column({ type: 'varchar', length: 3, default: 'PEN' })
  moneda: 'PEN' | 'USD';

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  monto: string;

  @Column({ type: 'date' })
  nextDate: string; // próxima fecha de generación

  @Column({ type: 'date', nullable: true })
  lastDate?: string | null;

  @Column({ type: 'smallint', nullable: true })
  remaining?: number | null; // solo para cuotas

  @Column({ type: 'varchar', length: 32, nullable: true })
  tarjeta?: string | null; // para crédito

  @Column({ type: 'varchar', length: 32, nullable: true })
  tarjetaPago?: string | null; // para débito pago_tarjeta si aplica

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

