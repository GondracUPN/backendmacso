import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm';

@Entity('cards')
export class Card {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ name: 'user_id' })
  userId: number;

  // interbank | bcp_amex | bcp_visa | bbva | io | saga
  @Column({ type: 'varchar', length: 20 })
  tipo: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  creditLine: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
