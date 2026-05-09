import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('ebay_search_items')
@Index('idx_ebay_search_items_key_item', ['searchKey', 'itemKey'], { unique: true })
@Index('idx_ebay_search_items_key_listed', ['searchKey', 'listedAt'])
export class EbaySearchItem {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'search_key', type: 'varchar', length: 80 })
  searchKey: string;

  @Column({ name: 'item_key', type: 'varchar', length: 255 })
  itemKey: string;

  @Column({ type: 'varchar', length: 500 })
  query: string;

  @Column({ type: 'varchar', length: 40, nullable: true })
  condition?: string | null;

  @Column({ name: 'buying_options', type: 'varchar', length: 80, nullable: true })
  buyingOptions?: string | null;

  @Column({ type: 'varchar', length: 40 })
  sort: string;

  @Column({ name: 'pawn_only', type: 'boolean', default: false })
  pawnOnly: boolean;

  @Column({ name: 'ebay_offset', type: 'integer', nullable: true })
  ebayOffset?: number | null;

  @Column({ name: 'listed_at', type: 'timestamptz', nullable: true })
  listedAt?: Date | null;

  @Column({ type: 'jsonb' })
  item: Record<string, any>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
