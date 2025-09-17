import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Producto } from '../producto/producto.entity';

@Entity()
export class Venta {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  productoId: number;

  @ManyToOne(() => Producto, p => p /* opcional agregar ventas en Producto */, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'productoId' })
  producto: Producto;

  // — Campos ingresados por el usuario —
  @Column('decimal', { precision: 10, scale: 4 })
  tipoCambio: number;         // ejemplo: 3.85

  @Column({ type: 'date' })
  fechaVenta: string;         // YYYY-MM-DD

  @Column('decimal', { precision: 12, scale: 2 })
  precioVenta: number;        // en S/

  // — Campos calculados —
  @Column('decimal', { precision: 12, scale: 2 })
  ganancia: number;           // S/

  @Column('decimal', { precision: 7, scale: 3 })
  porcentajeGanancia: number; // %

  // — Opcional: vendedor asignado a la venta —
  @Column({ type: 'varchar', length: 20, nullable: true })
  vendedor?: 'Gonzalo' | 'Renato' | null;


  @CreateDateColumn()
  createdAt: Date;
}
