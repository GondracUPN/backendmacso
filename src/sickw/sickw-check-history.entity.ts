import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('sickw_check_history')
@Index('idx_sickw_history_identifier_service', ['identifier', 'serviceId'])
@Index('idx_sickw_history_checked_at', ['checkedAt'])
export class SickwCheckHistory {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'service_id', type: 'varchar', length: 32 })
  serviceId: string;

  @Column({ name: 'service_name', type: 'varchar', length: 120 })
  serviceName: string;

  @Column({ name: 'cost_usd', type: 'numeric', precision: 10, scale: 3, default: 0 })
  costUSD: string;

  @Column({ type: 'varchar', length: 32 })
  identifier: string;

  @Column({ type: 'varchar', length: 12, nullable: true })
  type?: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  serial?: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  imei?: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  imei2?: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  fields: Array<{ label: string; value: string; tone?: 'good' | 'warn' | 'bad' }>;

  @Column({ type: 'text', nullable: true })
  raw?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  results?: unknown[] | null;

  @CreateDateColumn({ name: 'checked_at', type: 'timestamptz' })
  checkedAt: Date;
}
