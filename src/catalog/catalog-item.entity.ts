import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// Las filas apple_* pertenecen al catálogo Apple (src/apple-catalog) y comparten tabla sin cambiar el esquema.
export type CatalogKind =
  | 'product_option'
  | 'expense_concept'
  | 'apple_catalog_state'
  | 'apple_catalog_snapshot'
  | 'apple_specs_dataset'
  | 'apple_catalog_override'
  | 'apple_everymac_page';

@Entity('app_catalog_items')
export class CatalogItem {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 40 })
  kind: CatalogKind;

  @Column({ type: 'varchar', length: 40, nullable: true })
  productType?: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  family?: string | null;

  @Column({ type: 'varchar', length: 140 })
  value: string;

  @Column({ type: 'varchar', length: 140 })
  label: string;

  @Column({ type: 'boolean', default: false })
  appliesDebit: boolean;

  @Column({ type: 'boolean', default: false })
  appliesCredit: boolean;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any> | null;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  /** Dueño de un concepto de gasto. NULL = compartido (opciones de producto y conceptos anteriores a este cambio). */
  @Index('idx_catalog_owner_user')
  @Column({ type: 'int', nullable: true })
  ownerUserId?: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
