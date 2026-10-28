import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('accesorio_vinculo_propuesta')
export class AccesorioVinculoPropuesta {
  @PrimaryGeneratedColumn() id: number;
  @Column() productoId: number;
  @Column({ type: 'int', nullable: true }) referenciaId: number | null;
  @Column({ type: 'jsonb', nullable: true }) datosReferenciaPropuesta: any;
  @Column() grupo: string;
  @Column({ type: 'jsonb' }) productoIds: number[];
  @Column({ type: 'jsonb' }) snapshot: any[];
  @Column({ length: 64 }) snapshotHash: string;
  @Column({ type: 'int' }) puntuacion: number;
  @Column({ type: 'text' }) motivo: string;
  @Column({ default: false }) ambigua: boolean;
  @Column({ default: false }) posibleDuplicado: boolean;
  @Column({ default: 'pendiente' }) estado: 'pendiente' | 'aceptada' | 'rechazada' | 'obsoleta';
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) resueltoAt?: Date | null;
  @Column({ type: 'text', nullable: true }) resueltoPor?: string | null;
}

@Entity('accesorio_vinculo_auditoria')
export class AccesorioVinculoAuditoria {
  @PrimaryGeneratedColumn() id: number;
  @Column() productoId: number;
  @Column({ type: 'int', nullable: true }) referenciaIdAnterior: number | null;
  @Column({ type: 'int', nullable: true }) referenciaIdNuevo: number | null;
  @Column() accion: 'vincular' | 'desvincular';
  // ID de la propuesta de origen, no ID del producto.
  @Column({ type: 'int', nullable: true }) loteId: number | null;
  @Column({ type: 'int', nullable: true }) revierteAuditoriaId?: number | null;
  @Column({ type: 'text' }) usuario: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

@Entity('accesorio_vinculo_operacion')
export class AccesorioVinculoOperacion {
  @PrimaryGeneratedColumn() id: number;
  @Column() accion: string;
  @Column({ length: 100 }) idempotencyKey: string;
  @Column({ length: 64 }) operationHash: string;
  @Column({ type: 'jsonb' }) resultado: any;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
