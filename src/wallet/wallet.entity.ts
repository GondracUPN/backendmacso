import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  UpdateDateColumn,
} from 'typeorm';

@Entity('wallets')
export class Wallet {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column({ name: 'user_id', unique: true })
  userId: number;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  efectivoPen: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  efectivoUsd: string;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
