// src/producto/producto-valor.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity()
export class ProductoValor {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('decimal', { precision: 10, scale: 2 })
  valorProducto: number;

  @Column('decimal', { precision: 10, scale: 2 })
  valorDec: number;

  @Column('decimal', { precision: 10, scale: 2 })
  peso: number;

  @Column()
  fechaCompra: Date;

  // —————————————————————————————————————————————————
  // Los siguientes tres campos se calcularán en el servicio:
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  valorSoles: number;

  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  costoEnvio: number;

  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  costoTotal: number;
}
