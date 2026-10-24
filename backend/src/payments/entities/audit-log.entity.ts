import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';
import { PaymentState } from './payment.entity';

@Index('idx_audit_timestamp', ['timestamp'])
@Index('idx_audit_action_ts', ['action', 'timestamp'])
@Index('idx_audit_payment_ts', ['paymentId', 'timestamp'])
@Index('idx_audit_movement_ts', ['movementId', 'timestamp'])
@Index('idx_audit_user_ts', ['userId', 'timestamp'])
@Index('idx_audit_actor_ts', ['actorUsername', 'timestamp'])
@Index('idx_audit_target_user_ts', ['targetUserId', 'timestamp'])
@Index('idx_audit_bank_transfer_ts', ['bankTransferId', 'timestamp'])
@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  paymentId?: string | null;

  @Column({ type: 'uuid', nullable: true })
  movementId?: string | null;

  @Column({ type: 'uuid', nullable: true })
  targetUserId?: string | null;

  @Column({ type: 'uuid', nullable: true })
  bankTransferId?: string | null;

  @Column()
  userId: string;

  @Column({ type: 'text', nullable: true })
  actorUsername?: string | null;

  @Column()
  action: string;

  @Column({ type: 'enum', enum: PaymentState, nullable: true })
  beforeState?: PaymentState | null;

  @Column({ type: 'enum', enum: PaymentState, nullable: true })
  afterState?: PaymentState | null;

  @Column({ type: 'text', nullable: true })
  metadata?: string | null;

  @CreateDateColumn()
  timestamp: Date;
}
