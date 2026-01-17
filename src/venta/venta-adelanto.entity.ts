import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { Producto } from '../producto/producto.entity';

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

  @Column({ type: 'int', nullable: true })
  ventaId?: number | null;

  @Column({ type: 'timestamp', nullable: true })
  completadoAt?: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
