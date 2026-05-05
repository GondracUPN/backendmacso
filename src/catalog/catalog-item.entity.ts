import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type CatalogKind = 'product_option' | 'expense_concept';

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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
