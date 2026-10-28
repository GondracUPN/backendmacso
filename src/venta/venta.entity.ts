import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { Producto } from '../producto/producto.entity';

@Entity()
export class Venta {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  productoId: number;

  @ManyToOne(
    () => Producto,
    (p) => p /* opcional agregar ventas en Producto */,
    { onDelete: 'RESTRICT' },
  )
  @JoinColumn({ name: 'productoId' })
  producto: Producto;

  // — Campos ingresados por el usuario —
  @Column('decimal', { precision: 10, scale: 4 })
  tipoCambio: number; // ejemplo: 3.85

  // Tipo de cambio por vendedor cuando la venta es conjunta
  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  tipoCambioGonzalo?: number | null;

  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  tipoCambioRenato?: number | null;

  @Column({ type: 'date' })
  fechaVenta: string; // YYYY-MM-DD

  @Column('decimal', { precision: 12, scale: 2 })
  precioVenta: number; // en S/

  @Column({ type: 'int', default: 1 })
  cantidad: number;

  @Column({ type: 'varchar', length: 20, default: 'unidad' })
  modalidad: 'unidad' | 'mayor';

  // Lotes internos de los que salieron las unidades de un accesorio agrupado.
  // Permite mostrar un solo stock en Inventario sin perder la trazabilidad.
  @Column({ type: 'jsonb', nullable: true })
  distribucionStock?: Array<{ productoId: number; cantidad: number; costoUnitario?: number }> | null;

  // — Campos calculados —
  @Column('decimal', { precision: 12, scale: 2 })
  ganancia: number; // S/

  @Column('decimal', { precision: 7, scale: 3 })
  porcentajeGanancia: number; // %

  // — Opcional: vendedor asignado a la venta —
  @Column({ type: 'varchar', length: 80, nullable: true })
  vendedor?: string | null;

  // — Seguimiento financiero —
  // fechaVenta es la fecha comercial (entrega). La reserva se conserva aparte.
  @Column({ type: 'date', nullable: true })
  fechaReserva?: string | null;

  @Column('decimal', { precision: 12, scale: 2, nullable: true })
  precioLista?: number | null; // precio pactado antes de descuentos

  @Column('decimal', { precision: 12, scale: 2, default: 0 })
  descuento: number;

  @Column({ type: 'varchar', length: 3, default: 'PEN' })
  moneda: 'PEN' | 'USD';

  @Column({ type: 'varchar', length: 20, default: 'entregada' })
  estadoComercial: 'reservada' | 'entregada' | 'cancelada';

  // 'pendiente' = venta anterior al sistema financiero cuyos cobros no se han conciliado.
  @Column({ type: 'varchar', length: 20, default: 'no_aplica' })
  conciliacionHistorica: 'no_aplica' | 'pendiente' | 'confirmada' | 'confirmada_sin_fecha';

  @Column({ type: 'text', nullable: true })
  conciliacionNota?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  conciliadaAt?: Date | null;

  // true cuando el costo es desconocido: la utilidad queda pendiente de calcular.
  @Column({ type: 'boolean', default: false })
  costoPendiente: boolean;

  // Agrupa varias ventas registradas en una misma operación (p. ej. MacBook + accesorios).
  @Column({ type: 'varchar', length: 64, nullable: true })
  grupoOperacion?: string | null;

  @Column({ type: 'boolean', default: false })
  ventaRapida: boolean;

  // Clave de idempotencia de la operación que creó la venta (evita duplicados al reintentar).
  @Column({ type: 'varchar', length: 120, nullable: true, unique: true })
  operacionKey?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  operacionHash?: string | null;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  costoDevuelto: number;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  precioDevuelto: number;

  @Column({ type: 'int', default: 0 })
  cantidadDevuelta: number;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  costoCompletadoTotal?: number | null;
  @Column({ type: 'text', nullable: true })
  costoDocumento?: string | null;
  @Column({ type: 'int', nullable: true })
  costoCompletadoPor?: number | null;
  @Column({ type: 'timestamptz', nullable: true })
  costoCompletadoAt?: Date | null;

  // Anulación completa: la venta queda cancelada sin ingresos ni pagos vigentes.
  @Column({ type: 'timestamptz', nullable: true })
  anuladaAt?: Date | null;
  @Column({ type: 'int', nullable: true })
  anuladaPor?: number | null;
  @Column({ type: 'text', nullable: true })
  anulacionMotivo?: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
