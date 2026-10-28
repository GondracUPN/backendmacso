import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('accesorio_referencia')
export class AccesorioReferencia {
  @PrimaryGeneratedColumn() id: number;
  @Column() categoria: string;
  @Column({ default: '' }) marca: string;
  @Column() modelo: string;
  @Column({ default: '' }) generacion: string;
  @Column({ default: '' }) variante: string;
  @Column() estado: string;
  @Column() originalidad: string;
  @Column({ type: 'text', nullable: true }) compatibilidad?: string | null;
  @Column({ type: 'text', nullable: true }) fotoUrl?: string | null;
  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true }) precioPublicadoSoles?: number | null;
  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true }) precioMinimoSoles?: number | null;
  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true }) precioMayoristaSoles?: number | null;
  @Column({ type: 'int', nullable: true }) cantidadMinimaMayorista?: number | null;
  @Column({ default: true }) activo: boolean;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

export const referenceIdentityKeys = ['categoria', 'marca', 'modelo', 'generacion', 'variante', 'estado', 'originalidad'] as const;
export const normalizeReferenceText = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
