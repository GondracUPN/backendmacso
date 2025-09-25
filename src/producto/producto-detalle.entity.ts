// producto-detalle.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity()
export class ProductoDetalle {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: true })
  gama: string;

  @Column({ nullable: true })
  procesador: string;

  @Column({ nullable: true })
  generacion: string;

  @Column({ nullable: true })
  modelo: string;

  @Column({ name: 'tamanio', type: 'varchar', length: 50, nullable: true })
  tamaño?: string;


  @Column({ nullable: true })
  almacenamiento: string;

  @Column({ nullable: true })
  ram: string;

  @Column({ nullable: true })
  conexion: string;

  @Column({ nullable: true })
  descripcionOtro: string;
}
