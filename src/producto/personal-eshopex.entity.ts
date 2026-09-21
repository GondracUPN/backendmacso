import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('personal_eshopex')
export class PersonalEshopex {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 80 })
  trackingEshop: string;

  @Column({ type: 'text', default: 'Personal' })
  descripcion: string;

  @Column({ type: 'numeric', precision: 10, scale: 2, nullable: true })
  peso?: number | null;

  // Campo legado: se conserva en la tabla para no hacer un borrado destructivo,
  // pero Personal ya no lo recibe, actualiza ni devuelve.
  @Column({ type: 'numeric', precision: 10, scale: 2, default: 0, select: false })
  valorDec: number;

  @Column({ type: 'numeric', precision: 10, scale: 2, default: 0 })
  costoEnvio: number;

  @Column({ type: 'varchar', length: 120, nullable: true })
  estatusEsho?: string | null;

  @Column({ type: 'date', nullable: true })
  fechaRecepcion?: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  fechaRecepcionRaw?: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  casillero?: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  account?: string | null;

  @Column({ type: 'boolean', default: false })
  despacho: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  despachoAt?: Date | null;

  @Column({ type: 'boolean', default: false })
  recogido: boolean;

  @Column({ type: 'date', nullable: true })
  fechaRecogido?: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
