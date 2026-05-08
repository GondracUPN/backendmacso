import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../auth/entities/user.entity';

@Entity('gastos_presupuestos')
@Unique(['userId', 'month'])
export class GastoBudget {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ name: 'user_id' })
  userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Index()
  @Column({ type: 'varchar', length: 7 })
  month: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  amount: string;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
