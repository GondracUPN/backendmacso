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

  @Column({ name: 'cuotas_meses', type: 'smallint', nullable: true })
  cuotasMeses?: number | null;

  @Column({ type: 'varchar', length: 3, default: 'PEN' })
  moneda: 'PEN' | 'USD';

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  monto: string;

  @Column({ name: 'cantidad_500', type: 'int', nullable: true })
  cantidad500?: number | null;

  @Column({ name: 'destinatario_500', type: 'varchar', length: 12, nullable: true })
  destinatario500?: 'yo' | 'renato' | null;

  @Column({ name: 'sale_id', type: 'int', nullable: true })
  saleId?: number | null;

  @Column({ name: 'sale_sku', type: 'varchar', length: 100, nullable: true })
  saleSku?: string | null;

  @Column({ name: 'sale_payment_type', type: 'varchar', length: 12, nullable: true })
  salePaymentType?: 'direct' | 'card' | 'debt' | null;

  @Column({ name: 'sale_received_amount', type: 'numeric', precision: 12, scale: 2, nullable: true })
  saleReceivedAmount?: string | null;

  @Column({ name: 'sale_paid_at', type: 'date', nullable: true })
  salePaidAt?: string | null;

  @Column({ name: 'sale_payment_history', type: 'jsonb', nullable: true })
  salePaymentHistory?: Array<{ amount: number; paidAt: string; units500?: number }> | null;

  @Column({ name: 'sale_exchange_rate', type: 'numeric', precision: 10, scale: 4, nullable: true })
  saleExchangeRate?: string | null;

  @Column({ name: 'itf_ingreso_id', type: 'int', nullable: true })
  itfIngresoId?: number | null;

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
