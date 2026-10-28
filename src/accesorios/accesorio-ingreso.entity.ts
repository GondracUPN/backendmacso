import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('accesorio_ingreso')
export class AccesorioIngreso {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true, length: 100 }) idempotencyKey: string;
  @Column({ length: 64 }) operationHash: string;
  @Column({ type: 'jsonb' }) resultado: any;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
