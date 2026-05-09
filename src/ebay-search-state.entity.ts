import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('ebay_search_state')
@Index('idx_ebay_search_state_key', ['searchKey'], { unique: true })
export class EbaySearchState {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'search_key', type: 'varchar', length: 80 })
  searchKey: string;

  @Column({ name: 'next_ebay_offset', type: 'integer', default: 0 })
  nextEbayOffset: number;

  @Column({ name: 'last_cache_total', type: 'integer', default: 0 })
  lastCacheTotal: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
