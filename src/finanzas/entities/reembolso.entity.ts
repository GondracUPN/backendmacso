import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { ReembolsoEvento } from './reembolso-evento.entity';

export const ESTADOS_REEMBOLSO = [
  'en_transito',
  'incidencia',
  'reclamo_abierto',
  'aprobado',
  'reembolso_parcial',
  'recibido',
  'rechazado',
  'perdida_definitiva',
] as const;
export type EstadoReembolso = (typeof ESTADOS_REEMBOLSO)[number];

@Entity('reembolsos')
export class Reembolso {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ name: 'producto_id', type: 'int' })
  productoId: number;

  @Column({ type: 'varchar', length: 30, default: 'incidencia' })
  estado: EstadoReembolso;

  @Column({ type: 'varchar', length: 3, default: 'PEN' })
  moneda: 'PEN' | 'USD';

  // Tipo de cambio de la compra original (para medir diferencias cambiarias).
  @Column({
    name: 'tipo_cambio_compra',
    type: 'numeric',
    precision: 10,
    scale: 4,
    nullable: true,
  })
  tipoCambioCompra?: string | null;

  // Costo del producto en soles al momento de la compra.
  @Column({ name: 'costo_original', type: 'numeric', precision: 12, scale: 2 })
  costoOriginal: string;

  @Column({
    name: 'gastos_adicionales',
    type: 'numeric',
    precision: 12,
    scale: 2,
    default: 0,
  })
  gastosAdicionales: string;

  // Importes en la moneda del reclamo.
  @Column({
    name: 'monto_reclamado',
    type: 'numeric',
    precision: 12,
    scale: 2,
    default: 0,
  })
  montoReclamado: string;

  @Column({
    name: 'monto_aprobado',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
  })
  montoAprobado?: string | null;

  @Column({ name: 'cuenta_devolucion_id', type: 'int', nullable: true })
  cuentaDevolucionId?: number | null;

  @Column({ name: 'fecha_incidencia', type: 'date', nullable: true })
  fechaIncidencia?: string | null;

  @Column({ name: 'fecha_cierre', type: 'date', nullable: true })
  fechaCierre?: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  referencia?: string | null;

  @Column({ type: 'text', nullable: true })
  motivo?: string | null;

  @OneToMany(() => ReembolsoEvento, (e) => e.reembolso)
  eventos?: ReembolsoEvento[];

  @VersionColumn({ default: 1 })
  version: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
