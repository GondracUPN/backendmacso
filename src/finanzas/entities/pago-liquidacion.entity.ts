import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { VentaPago } from './venta-pago.entity';

/**
 * Eventos posteriores al pago del cliente:
 * - liquidacion: la pasarela o el tercero entrega el dinero (bruto - comisión = neto).
 * - devolucion: se devuelve dinero al cliente.
 * - contracargo / reversion_contracargo: disputa bancaria y su resolución a favor.
 */
export const TIPOS_EVENTO_PAGO = [
  'liquidacion',
  'devolucion',
  'contracargo',
  'reversion_contracargo',
] as const;
export type TipoEventoPago = (typeof TIPOS_EVENTO_PAGO)[number];

@Entity('pago_liquidaciones')
export class PagoLiquidacion {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ name: 'pago_id', type: 'int' })
  pagoId: number;

  @ManyToOne(() => VentaPago, (p) => p.liquidaciones, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'pago_id' })
  pago?: VentaPago;

  @Column({ type: 'varchar', length: 30, default: 'liquidacion' })
  tipo: TipoEventoPago;

  @Index()
  @Column({ type: 'date' })
  fecha: string;

  // Importe del pago que queda resuelto (en soles).
  @Column({ name: 'monto_bruto', type: 'numeric', precision: 12, scale: 2 })
  montoBruto: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  comision: string;

  // Dinero que efectivamente entra (liquidación) o sale (devolución / contracargo) de la cuenta.
  @Column({ name: 'monto_neto', type: 'numeric', precision: 12, scale: 2 })
  montoNeto: string;

  @Column({ name: 'cuenta_id', type: 'int', nullable: true })
  cuentaId?: number | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  referencia?: string | null;

  @Index({ unique: true })
  @Column({ name: 'idempotency_key', type: 'varchar', length: 120 })
  idempotencyKey: string;

  @Column({ type: 'text', nullable: true })
  nota?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
