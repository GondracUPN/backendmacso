import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { Producto } from '../producto/producto.entity';

export type VentaAdelantoCuota = {
  fecha: string;
  monto: number;
  banco?: 'bcp' | 'interbank' | 'bbva';
  tipoPago?: 'direct' | 'card';
  // Pago del libro financiero que originó la cuota (evita duplicarla al sincronizar).
  pagoId?: number;
};

@Entity()
export class VentaAdelanto {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  productoId: number;

  @ManyToOne(() => Producto, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'productoId' })
  producto: Producto;

  @Column('decimal', { precision: 12, scale: 2 })
  montoAdelanto: number; // S/

  @Column({ type: 'date' })
  fechaAdelanto: string; // YYYY-MM-DD

  @Column('decimal', { precision: 12, scale: 2 })
  montoVenta: number; // S/

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  cuotas: VentaAdelantoCuota[];

  @Column({ type: 'int', nullable: true })
  ventaId?: number | null;

  @Column({ type: 'timestamp', nullable: true })
  completadoAt?: Date | null;

  // Cancelación conservando historial: los pagos quedan como devueltos.
  @Column({ type: 'timestamptz', nullable: true })
  canceladoAt?: Date | null;

  @Column({ type: 'date', nullable: true })
  fechaDevolucion?: string | null;

  @Column('decimal', { precision: 12, scale: 2, nullable: true })
  montoDevuelto?: number | null;

  @Column({ type: 'text', nullable: true })
  motivoCancelacion?: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
