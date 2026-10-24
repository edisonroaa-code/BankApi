import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Index('idx_movements_reconciled_date', ['isReconciled', 'date'])
@Entity('movements')
export class Movement {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'timestamp' })
    date: Date;

    @Column('decimal', { precision: 15, scale: 0 }) // PYG has no decimals usually, but strict decimal is good
    amount: number;

    @Column()
    description: string;

    @Column({ unique: true })
    transactionId: string;

    @Column({ default: false })
    isReconciled: boolean;
}
