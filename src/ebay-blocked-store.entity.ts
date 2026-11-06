import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('ebay_blocked_stores')
export class EbayBlockedStore {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  seller: string;

  @Column({ type: 'boolean', default: true })
  blocked: boolean;
}
