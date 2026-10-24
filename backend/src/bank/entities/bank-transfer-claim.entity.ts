import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BankTransfer, numericTransformer } from './bank-transfer.entity';

export enum ClaimReferenceType {
  TICKET = 'TICKET',
  CLIENTE = 'CLIENTE',
  /** Conciliacion del admin: la transferencia paga una consulta de cobrador. */
  CONSULTA = 'CONSULTA',
}

export enum ClaimStatus {
  ACTIVA = 'ACTIVA',
  ANULADA = 'ANULADA',
}

/**
 * Cada toma de una transferencia, por un monto. Historial inmutable: anular no borra, marca ANULADA.
 * Lo normal es una sola toma por el total; se admiten varias (un envio que paga dos cobros) y la
 * garantia contra el doble uso pasa a ser el saldo: la suma de las tomas activas nunca supera el
 * monto de la transferencia, ni lo tomado sobre una consulta supera lo que la consulta declaro.
 */
@Index('idx_claims_match_strength', ['matchStrength', 'claimedAt'], { where: `"status" = 'ACTIVA'` })
@Index('idx_claims_transfer_status', ['bankTransferId', 'status'])
@Index('idx_claims_reference', ['referenceType', 'referenceValue', 'status'])
@Index('idx_claims_claimed_by', ['claimedById', 'claimedAt'])
@Index('idx_claims_payment', ['paymentId'])
@Entity('bank_transfer_claims')
export class BankTransferClaim {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => BankTransfer, { nullable: false })
  @JoinColumn({ name: 'bankTransferId' })
  bankTransfer?: BankTransfer;

  @Column({ type: 'uuid' })
  bankTransferId: string;

  @Column({ type: 'text', unique: true })
  receiptNumber: string;

  /** Parte del monto de la transferencia que consume esta toma. Lo habitual es el total. */
  @Column('numeric', { precision: 18, scale: 2, transformer: numericTransformer })
  amount: number;

  @Column({ type: 'enum', enum: ClaimReferenceType })
  referenceType: ClaimReferenceType;

  /** Referencia normalizada (sin espacios, mayusculas, sin ceros a la izquierda si es numerica). */
  @Column({ type: 'text' })
  referenceValue: string;

  @Column({ type: 'uuid', nullable: true })
  paymentId: string | null;

  /** Con que evidencia se armo la pareja consulta <-> transferencia: FUERTE, MEDIA o DEBIL. */
  @Column({ type: 'text', nullable: true })
  matchStrength: string | null;

  /** Detalle de la evidencia (REFERENCIA, CUENTA_CONOCIDA, MONTO...), separada por comas. */
  @Column({ type: 'text', nullable: true })
  matchEvidence: string | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ type: 'text' })
  claimedById: string;

  @Column({ type: 'text', nullable: true })
  claimedByUsername: string | null;

  @Column({ type: 'text', nullable: true })
  claimedByName: string | null;

  @Column({ type: 'text' })
  claimedByRole: string;

  @Column({ type: 'timestamptz' })
  claimedAt: Date;

  @Column({ type: 'enum', enum: ClaimStatus, default: ClaimStatus.ACTIVA })
  status: ClaimStatus;

  @Column({ type: 'text', nullable: true })
  voidedById: string | null;

  @Column({ type: 'text', nullable: true })
  voidedByUsername: string | null;

  @Column({ type: 'text', nullable: true })
  voidedByName: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  voidedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  voidReason: string | null;

  @Column({ type: 'int', default: 0 })
  printCount: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastPrintedAt: Date | null;

  /** Generado por el cliente: reintentar por mala red no crea una segunda toma. */
  @Column({ type: 'uuid', unique: true })
  idempotencyKey: string;
}
