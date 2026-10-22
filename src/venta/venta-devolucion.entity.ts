import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('venta_devoluciones')
export class VentaDevolucion {
  @PrimaryGeneratedColumn() id: number;
  @Column({ type: 'int' }) ventaId: number;
  @Column({ type: 'int' }) cantidad: number;
  @Column({ type: 'numeric', precision: 12, scale: 2 }) monto: string;
  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 }) costoRecuperado: string;
  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 }) precioAnulado: string;
  @Column({ type: 'varchar', length: 20 }) destino: 'disponible' | 'revision' | 'averiado' | 'baja';
  @Column({ type: 'date' }) fecha: string;
  @Column({ type: 'text' }) motivo: string;
  @Column({ type: 'int', nullable: true }) cuentaId?: number | null;
  @Column({ type: 'int', nullable: true }) userId?: number | null;
  @Column({ type: 'varchar', length: 100, unique: true }) operacionKey: string;
  @Column({ type: 'varchar', length: 64 }) operacionHash: string;
  @Column({ type: 'jsonb' }) lotes: Array<{ productoId: number; cantidad: number; costoUnitario: number }>;
  @CreateDateColumn() createdAt: Date;
}
