import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn, Relation } from 'typeorm';
import { Producto } from '../producto/producto.entity';

export type AccesorioIncluidoStock = { productoId: number; nombre: string };

@Entity('producto_accesorios_stock')
export class ProductoAccesoriosStock {
  @PrimaryColumn('int')
  productoId: number;

  @OneToOne(() => Producto, (producto) => producto.accesoriosStock, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'productoId', foreignKeyConstraintName: 'producto_accesorios_stock_producto_fk' })
  producto: Relation<Producto>;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  accesorios: AccesorioIncluidoStock[];

  @Column({ type: 'int', default: 0 })
  revision: number;

  @Column({ type: 'int', default: 0 })
  revisionSincronizada: number;
}
