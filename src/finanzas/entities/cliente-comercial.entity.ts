import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('clientes_comerciales')
@Check(
  'clientes_comerciales_clase_check',
  "clase IN ('externo','propio','renato')",
)
@Check('clientes_comerciales_check', "NOT admite_saldo OR clase = 'externo'")
export class ClienteComercial {
  @PrimaryGeneratedColumn() id: number;
  @Column({ type: 'varchar', length: 120 }) nombre: string;
  @Column({ type: 'varchar', length: 15 }) clase:
    | 'externo'
    | 'propio'
    | 'renato';
  @Column({ name: 'admite_saldo', type: 'boolean', default: false })
  admiteSaldo: boolean;
  @Column({
    name: 'pedido_key',
    type: 'varchar',
    length: 120,
    nullable: true,
    unique: true,
  })
  pedidoKey?: string | null;
  @Column({ name: 'creado_por', type: 'int' }) creadoPor: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
