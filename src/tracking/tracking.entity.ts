// src/tracking/tracking.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Producto } from '../producto/producto.entity';

export type EstadoTracking =
  | 'comprado_sin_tracking' // no hay tracking aún
  | 'comprado_en_camino' // se tiene TrackingUSA (viajando hacia Eshopex)
  | 'en_eshopex' // recibido por Eshopex / camino a Lima
  | 'recogido'; // entregado/recogido

@Entity()
export class Tracking {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column()
  productoId: number;

  @ManyToOne(() => Producto, (p) => p.tracking, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'productoId' })
  producto: Producto;

  // -----------------------------
  // NUEVOS CAMPOS DE TRACKING
  // -----------------------------

  // Tracking del tramo USA → Eshopex
  @Column({ name: 'tracking_usa', nullable: true })
  trackingUsa?: string;

  @Column({ nullable: true })
  transportista?: string; // p.ej. USPS | UPS | FedEx | etc.

  @Column({ nullable: true })
  casillero?: string; // p.ej. Walter | Renato | etc.

  // Tracking del tramo Eshopex → Lima / destino final
  @Column({ name: 'tracking_eshop', nullable: true })
  trackingEshop?: string;

  // Fechas del tramo local
  @Column({ type: 'date', nullable: true })
  fechaRecepcion?: string; // recibido por Eshopex (o casillero local)

  @Column({ type: 'date', nullable: true })
  fechaRecogido?: string; // entregado/recogido

  // Estado calculado / persistido
  @Column({
    type: 'enum',
    enum: [
      'comprado_sin_tracking',
      'comprado_en_camino',
      'en_eshopex',
      'recogido',
    ],
    default: 'comprado_sin_tracking',
  })
  estado: EstadoTracking;
}
