import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export const TIPOS_CUENTA = [
  'efectivo', // caja propia
  'banco',
  'billetera', // Yape / Plin cuando se manejan aparte del banco
  'tercero', // repartidores u otras personas que retienen dinero
  'procesador', // pasarelas / POS que liquidan después
  'tarjeta_credito',
  'proveedor', // saldos a favor con proveedores
] as const;
export type TipoCuenta = (typeof TIPOS_CUENTA)[number];

/** Cuentas en las que es dinero propio disponible (no retenido por terceros ni deuda). */
export const TIPOS_DISPONIBLES: TipoCuenta[] = [
  'efectivo',
  'banco',
  'billetera',
];

@Entity('cuentas_financieras')
export class CuentaFinanciera {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  codigo: string;

  @Column({ type: 'varchar', length: 80 })
  nombre: string;

  @Column({ type: 'varchar', length: 20 })
  tipo: TipoCuenta;

  @Column({ type: 'varchar', length: 3, default: 'PEN' })
  moneda: 'PEN' | 'USD';

  // Código usado en gastos.tarjeta para enlazar movimientos existentes (bcp, interbank, efectivo, bcp_amex...).
  @Column({
    name: 'legacy_codigo',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  legacyCodigo?: string | null;

  @Column({ type: 'boolean', default: true })
  activo: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
