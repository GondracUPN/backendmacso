import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../auth/entities/user.entity';

@Entity('gastos')
export class Gasto {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ name: 'user_id' })
  userId: number;

  @ManyToOne(() => User, (u) => u.gastos, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'varchar', length: 140 })
  concepto: string; // 'comida' | 'gusto' | 'ingreso' | 'pago_tarjeta' | 'inversion' | 'pago_envios' | ...

  @Column({ name: 'detalle_gusto', type: 'text', nullable: true })
  detalleGusto?: string | null;

  @Column({ name: 'cuotas_meses', type: 'smallint', nullable: true })
  cuotasMeses?: number | null;

  @Column({ type: 'varchar', length: 3, default: 'PEN' })
  moneda: 'PEN' | 'USD';

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  monto: string;

  @Column({ type: 'date' })
  fecha: string;

  @Column({ name: 'metodo_pago', type: 'varchar', length: 10 })
  metodoPago: 'debito' | 'credito';

  // si es crédito: tarjeta usada (interbank|bcp_amex|bcp_visa|bbva|io|saga)
  @Column({ type: 'varchar', length: 32, nullable: true })
  tarjeta?: string | null;

  // si es DÉBITO y concepto === 'pago_tarjeta': tarjeta de CRÉDITO a la que se paga
  @Column({ name: 'tarjeta_pago', type: 'varchar', length: 32, nullable: true })
  tarjetaPago?: string | null;

  @Column({ type: 'text', nullable: true })
  notas?: string | null;

  // Opcionales para auditoría de moneda / pagos de tarjeta
  @Column({ name: 'tasa_usd_pen', type: 'numeric', precision: 8, scale: 4, nullable: true })
  tasaUsdPen?: string | null;

  // Equivalente en PEN del movimiento (si moneda='USD' => monto * tasaUsdPen)
  @Column({ name: 'monto_pen', type: 'numeric', precision: 12, scale: 2, nullable: true })
  montoPen?: string | null;

  // Para pagos de tarjeta desde débito: a qué moneda aplica el pago (PEN | USD)
  @Column({ name: 'pago_objetivo', type: 'varchar', length: 3, nullable: true })
  pagoObjetivo?: 'PEN' | 'USD' | null;

  // Para pagos a USD hechos en PEN, el monto en USD aplicado (con la tasa del día)
  @Column({ name: 'monto_usd_aplicado', type: 'numeric', precision: 12, scale: 2, nullable: true })
  montoUsdAplicado?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
