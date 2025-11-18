// src/producto/producto-detalle.entity.ts
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
  numero: string;

  @Column({ nullable: true })
  modelo: string;

  // Usar ASCII: 'tamano' para evitar problemas de codificación
  @Column({ name: 'tamano', type: 'varchar', nullable: true })
  tamano?: string;

  @Column({ nullable: true })
  almacenamiento: string;

  @Column({ nullable: true })
  ram: string;

  @Column({ nullable: true })
  conexion: string;

  @Column({ nullable: true })
  descripcionOtro: string;
}
