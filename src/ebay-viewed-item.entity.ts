import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('ebay_viewed_items')
@Index('idx_ebay_viewed_items_key', ['itemKey'], { unique: true })
@Index('idx_ebay_viewed_items_viewed_at', ['viewedAt'])
export class EbayViewedItem {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'item_key', type: 'varchar', length: 255 })
  itemKey: string;

  @Column({ name: 'item_url', type: 'varchar', length: 1000, nullable: true })
  itemUrl?: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  title?: string | null;

  // Primer precio visto (USD o puja actual en subastas) para comparar en revisiones futuras.
  @Column({ name: 'viewed_price', type: 'numeric', precision: 12, scale: 2, nullable: true })
  viewedPrice?: string | null;

  @Column({ name: 'viewed_currency', type: 'varchar', length: 8, nullable: true })
  viewedCurrency?: string | null;

  @Column({ name: 'viewed_at', type: 'timestamptz' })
  viewedAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
