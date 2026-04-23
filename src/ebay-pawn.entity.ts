import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('ebay_pawns')
export class EbayPawn {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ name: 'store_url', type: 'varchar', length: 255 })
  storeUrl: string;

  @Column({ name: 'store_name', type: 'varchar', length: 255 })
  storeName: string;

  @Index()
  @Column({ type: 'varchar', length: 120 })
  seller: string;

  @Column({ name: 'original_url', type: 'varchar', length: 255, nullable: true })
  originalUrl?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
