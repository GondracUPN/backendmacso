// producto.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';
import { ProductoDetalle } from './producto-detalle.entity';
import { ProductoValor } from './producto-valor.entity';
import { Tracking } from '../tracking/tracking.entity';
import { Venta } from '../venta/venta.entity';

@Entity()
export class Producto {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  tipo: string; // macbook, ipad, iphone, watch, otro

  @Column()
  estado: string; // nuevo, usado, roto

  // Accesorios marcados (Caja, Cubo, Cable)
  @Column({ type: 'text', array: true, default: '{}' })
  accesorios: string[];

  // producto.entity.ts

  @ManyToOne(() => ProductoDetalle, { cascade: true, eager: true })
  @JoinColumn()
  detalle: ProductoDetalle;

  @ManyToOne(() => ProductoValor, { cascade: true, eager: true })
  @JoinColumn()
  valor: ProductoValor;
  @OneToMany(() => Tracking, (t) => t.producto, {
    cascade: true,
    eager: true,
  })
  tracking: Tracking[];

  @OneToMany(() => Venta, (v) => v.producto)
  ventas: Venta[];
}
