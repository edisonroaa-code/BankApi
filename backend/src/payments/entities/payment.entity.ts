import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, ManyToOne, JoinColumn, OneToOne, Index, Check } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Movement } from '../../movements/entities/movement.entity';

export enum PaymentState {
    PENDIENTE_VERIFICACION = 'PENDIENTE_VERIFICACION',
    EN_REVISION = 'EN_REVISION',
    CONFIRMADO = 'CONFIRMADO',
    CONFIRMADO_MANUAL = 'CONFIRMADO_MANUAL',
    RECHAZADO = 'RECHAZADO',
}

@Index('idx_payments_created_at', ['createdAt'])
@Index('idx_payments_status_created_at', ['status', 'createdAt'])
@Index('idx_payments_created_by_created', ['createdById', 'createdAt'])
@Index('idx_payments_status_created_by', ['status', 'createdById'])
// La consulta previa en create() es solo UX: la unicidad real vive en PostgreSQL.
@Index('uq_payments_payment_ref_active', ['paymentRef'], {
    unique: true,
    where: `"paymentRef" IS NOT NULL AND "paymentRef" <> '' AND "status" <> 'RECHAZADO'`,
})
@Index('uq_payments_file_hash_active', ['fileHash'], {
    unique: true,
    where: `"fileHash" IS NOT NULL AND "fileHash" <> '' AND "status" <> 'RECHAZADO'`,
})
@Index('idx_payments_client_code_created', ['clientCode', 'createdAt'])
@Index('idx_payments_source_bank_created', ['sourceBank', 'createdAt'])
@Index('idx_payments_review_claim', ['reviewClaimedById', 'reviewClaimExpiresAt'])
// Declarada aqui ademas de en la migracion: si no, una regeneracion de migraciones la borraria.
@Check('ck_payments_allocated', `"allocatedAmount" >= 0 AND "allocatedAmount" <= "amount"`)
@Entity('payments')
export class Payment {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('decimal', { precision: 15, scale: 0 })
    amount: number;

    /**
     * Cuanto de esta consulta ya esta cubierto por transferencias del banco. La base impide que
     * supere `amount` (`ck_payments_allocated`): una consulta no puede cobrarse dos veces.
     */
    @Column('numeric', { precision: 18, scale: 2, default: 0 })
    allocatedAmount: number;

    @Column({ default: 'PYG' })
    currency: string;

    @Column({ nullable: true })
    clientName: string;

    @Column({ nullable: true })
    clientCode: string;

    @Column({ nullable: true })
    paymentRef: string;

    @Column({ nullable: true })
    sourceBank: string; // Nuevo: Entidad Financiera

    /** Cuenta receptora Atlas (API); NULL conserva históricos aún no clasificados. */
    @Column({ type: 'boolean', nullable: true, default: null })
    isAtlasAccount: boolean | null;

    @Column({ type: 'text', nullable: true })
    observation: string;

    @Column({ type: 'text', nullable: true })
    fileHash: string; // SHA-256 hash for duplicate detection

    @Column({ type: 'text', nullable: true })
    proofUrl: string;

    // Perceptual hash of the proof image (helps detect re-sent/compressed duplicates)
    @Column({ type: 'text', nullable: true })
    proofDhash?: string | null;

    @Column({ type: 'enum', enum: PaymentState, default: PaymentState.PENDIENTE_VERIFICACION })
    status: PaymentState;

    @Column({ type: 'text', nullable: true })
    rejectionReason: string;

    // Motivo visible para el cobrador al aprobar/rechazar (ej: "Conciliado con extracto", "Datos no coinciden", etc).
    @Column({ type: 'text', nullable: true })
    decisionReason?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @ManyToOne(() => User)
    createdBy: User;

    @Column()
    createdById: string;

    // Reconciliation Link
    @OneToOne(() => Movement, { nullable: true })
    @JoinColumn()
    matchedMovement: Movement;

    @Column({ nullable: true })
    matchedMovementId: string;

    @Column({ nullable: true })
    printedAt: Date;

    // Cashier step (Caja): after printing, mark the payment as paid/processed in cash desk.
    @Column({ type: 'timestamp', nullable: true })
    cashPaidAt?: Date | null;

    @Column({ type: 'text', nullable: true })
    cashPaidById?: string | null;

    @Column({ type: 'text', nullable: true })
    cashPaidByUsername?: string | null;

    @Column({ type: 'text', nullable: true })
    cashPaidByName?: string | null;

    // Review "claim" fields (to avoid two managers validating the same payment at once)
    @Column({ type: 'text', nullable: true })
    reviewClaimedById?: string | null;

    @Column({ type: 'text', nullable: true })
    reviewClaimedByUsername?: string | null;

    @Column({ type: 'text', nullable: true })
    reviewClaimedByName?: string | null;

    @Column({ type: 'timestamp', nullable: true })
    reviewClaimedAt?: Date | null;

    @Column({ type: 'timestamp', nullable: true })
    reviewClaimExpiresAt?: Date | null;

    @Column({ type: 'text', nullable: true })
    verifiedById?: string | null;

    @Column({ type: 'text', nullable: true })
    verifiedByUsername?: string | null;

    @Column({ type: 'text', nullable: true })
    verifiedByName?: string | null;

    @Column({ type: 'timestamp', nullable: true })
    verifiedAt?: Date | null;
}
