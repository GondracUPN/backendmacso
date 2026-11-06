import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

// Preferencia comercial y último envío, independientes de lotes y movimientos.
@Entity('accesorio_catalogo')
export class AccesorioCatalogo {
  @PrimaryColumn({ type: 'varchar', length: 100 }) key: string;
  @Column({ default: false }) seleccionado: boolean;
  @Column({ type: 'jsonb', nullable: true }) payload: Record<string, any> | null;
  @Column({ type: 'varchar', length: 64, nullable: true }) syncHash: string | null;
  @Column({ type: 'text', nullable: true }) error: string | null;
  @Column({ type: 'timestamptz', nullable: true }) sincronizadoAt: Date | null;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
