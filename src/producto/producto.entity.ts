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

  // Control interno para saber si el HTML/DEC ya marcó factura subida
  @Column({ type: 'boolean', default: false })
  facturaDecSubida: boolean;

  @Column({ type: 'boolean', default: false })
  catalogoEnviado: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  catalogoEnviadoAt?: Date | null;

  // Agrupador de envíos para prorratear costo entre productos vinculados
  @Column({ type: 'varchar', length: 64, nullable: true })
  envioGrupoId?: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  vendedor?: string | null;

  @Column({ type: 'boolean', default: false })
  despachoCasillero: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  despachoCasilleroAt?: Date | null;

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
