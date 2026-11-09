import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { ClienteComercial } from './cliente-comercial.entity';
import { Venta } from '../../venta/venta.entity';
import { VentaPago } from './venta-pago.entity';
@Entity('cliente_saldos')
@Unique('cliente_saldos_pago_id_key', ['pagoId'])
@Index('cliente_saldos_fifo', ['clienteId', 'fecha', 'id'])
@Check('cliente_saldos_original_check', 'original > 0')
@Check(
  'cliente_saldos_disponible_check',
  'disponible >= 0 AND disponible <= original',
)
@Check('cliente_saldos_tipo_cambio_check', 'tipo_cambio > 0')
export class ClienteSaldo {
  @Column({ name: 'anulada_at', type: 'timestamptz', nullable: true })
  anuladaAt?: Date | null;
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'cliente_id', type: 'int' }) clienteId: number;
  @ManyToOne(() => ClienteComercial, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({
    name: 'cliente_id',
    foreignKeyConstraintName: 'cliente_saldos_cliente_id_fkey',
  })
  clienteIdRelacion: ClienteComercial;
  @Column({ name: 'venta_id', type: 'int' }) ventaId: number;
  @ManyToOne(() => Venta, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({
    name: 'venta_id',
    foreignKeyConstraintName: 'cliente_saldos_venta_id_fkey',
  })
  ventaIdRelacion: Venta;
  @Column({ name: 'pago_id', type: 'int' }) pagoId: number;
  @ManyToOne(() => VentaPago, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({
    name: 'pago_id',
    foreignKeyConstraintName: 'cliente_saldos_pago_id_fkey',
  })
  pagoIdRelacion: VentaPago;
  @Column({ type: 'int' }) sku: number;
  @Column({ type: 'numeric', precision: 12, scale: 2 }) original: string;
  @Column({ type: 'numeric', precision: 12, scale: 2 }) disponible: string;
  @Column({ type: 'varchar', length: 3 }) moneda: string;
  @Column({ name: 'monto_original', type: 'numeric', precision: 12, scale: 2 })
  montoOriginal: string;
  @Column({ name: 'equivalente_usd', type: 'numeric', precision: 12, scale: 2 })
  equivalenteUsd: string;
  @Column({ name: 'tipo_cambio', type: 'numeric', precision: 12, scale: 4 })
  tipoCambio: string;
  @Column({ type: 'date' }) fecha: string;
  @Column({ type: 'text' }) motivo: string;
  @Column({ name: 'creado_por', type: 'int' }) creadoPor: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
