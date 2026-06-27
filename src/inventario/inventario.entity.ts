import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Producto } from '../producto/producto.entity';

@Entity('inventario')
export class Inventario {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', unique: true })
  productoId: number;

  @ManyToOne(() => Producto, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'productoId' })
  producto: Producto;

  @Column({ type: 'boolean', default: false })
  enAlmacen: boolean;

  @Column({ type: 'varchar', length: 80, nullable: true })
  color?: string | null;

  @Column({ type: 'int', nullable: true })
  ciclosBateria?: number | null;

  @Column({ type: 'int', nullable: true })
  saludBateria?: number | null;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  primerPrecioSoles?: number | null;

  @Column({ type: 'date', nullable: true })
  garantiaHasta?: string | null;

  @Column({ type: 'boolean', default: false })
  tieneGarantia: boolean;

  @Column({ type: 'varchar', length: 30, nullable: true })
  tipoGarantia?: string | null;

  @Column({ type: 'varchar', length: 180, nullable: true })
  garantiaDetalle?: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  serial?: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  imei?: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  imei2?: string | null;

  @Column({ type: 'text', array: true, default: '{}' })
  accesorios: string[];

  @Column({ type: 'text', nullable: true })
  observaciones?: string | null;

  @Column({ type: 'varchar', length: 600, nullable: true })
  fotoUrl?: string | null;

  @Column({ type: 'varchar', length: 240, nullable: true })
  fotoPublicId?: string | null;

  @Column({ type: 'boolean', default: false })
  fotosTomadas: boolean;

  @Column({ type: 'boolean', default: false })
  marketplaceSubido: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
