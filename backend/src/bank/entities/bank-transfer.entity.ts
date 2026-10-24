import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum BankTransferStatus {
  DISPONIBLE = 'DISPONIBLE',
  /** Una parte del dinero ya fue tomada y todavia queda saldo libre. */
  PARCIAL = 'PARCIAL',
  TOMADA = 'TOMADA',
  REVERSADA = 'REVERSADA',
  BLOQUEADA = 'BLOQUEADA',
}

export enum BankTransferSource {
  ATLAS = 'ATLAS',
  MOCK = 'MOCK',
}

// numeric llega como string desde pg; los montos se exponen como number.
export const numericTransformer = {
  to: (value?: number | null) => value,
  from: (value?: string | null) => (value === null || value === undefined ? value : Number(value)),
};

/** Credito entrante visto en el banco. Solo lo escribe el sondeo del feed. */
@Index('idx_bank_transfers_movement_at', ['movementAt'])
@Index('idx_bank_transfers_status_movement_at', ['status', 'movementAt'])
@Index('idx_bank_transfers_amount_movement_at', ['amount', 'movementAt'])
// Declarada aqui ademas de en la migracion: si no, una regeneracion de migraciones la borraria.
@Check('ck_bank_transfers_allocated', `"allocatedAmount" >= 0 AND "allocatedAmount" <= "amount"`)
@Entity('bank_transfers')
export class BankTransfer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Huella construida solo con campos inmutables del movimiento: clave antidoble registro. */
  @Column({ type: 'text', unique: true })
  fingerprint: string;

  @Column({ type: 'enum', enum: BankTransferSource })
  source: BankTransferSource;

  @Column({ type: 'text' })
  accountNumber: string;

  @Column({ type: 'text', nullable: true })
  bankDocNumber: string | null;

  @Column({ type: 'text', nullable: true })
  bancardTxId: string | null;

  @Column('numeric', { precision: 18, scale: 2, transformer: numericTransformer })
  amount: number;

  @Column({ type: 'text' })
  currency: string;

  @Column({ type: 'timestamptz' })
  movementAt: Date;

  @Column({ type: 'date', nullable: true })
  processDate: string | null;

  @Column({ type: 'text' })
  concept: string;

  @Column({ type: 'text', nullable: true })
  senderName: string | null;

  @Column({ type: 'text', nullable: true })
  senderDoc: string | null;

  @Column({ type: 'text', nullable: true })
  senderAccount: string | null;

  /** Concepto escrito por quien envia (`infoAdicional.concepto`); suele traer el ticket o cliente. */
  @Column({ type: 'text', nullable: true })
  senderNote: string | null;

  // Datos de la operacion SIPAP vinculada (Consulta de Operaciones SIPAP + entidades participantes).
  // Movimientos v1.1 no informa el banco de origen; se completan en segundo plano si hay vinculo unico.
  @Column({ type: 'text', nullable: true })
  senderBankCode: string | null;

  @Column({ type: 'text', nullable: true })
  senderBankName: string | null;

  /** SPI o LBTR. */
  @Column({ type: 'text', nullable: true })
  channel: string | null;

  @Column({ type: 'text', nullable: true })
  sipapReference: string | null;

  @Column({ type: 'text', nullable: true })
  sipapReason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  enrichedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  txCode: string | null;

  @Column({ type: 'text', nullable: true })
  txDescription: string | null;

  @Column({ type: 'enum', enum: BankTransferStatus, default: BankTransferStatus.DISPONIBLE })
  status: BankTransferStatus;

  /**
   * Suma de las tomas activas. La base impide que supere `amount` (restriccion
   * `ck_bank_transfers_allocated`): esa es la garantia de que el mismo dinero no se use dos veces.
   */
  @Column('numeric', { precision: 18, scale: 2, default: 0, transformer: numericTransformer })
  allocatedAmount: number;

  @Column({ type: 'timestamptz', nullable: true })
  reversedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  blockedReason: string | null;

  /** Respuesta original del banco para auditoria. Nunca se envia a cajeros ni cobradores. */
  @Column({ type: 'jsonb' })
  rawPayload: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  firstSeenAt: Date;

  @Column({ type: 'timestamptz' })
  lastSeenAt: Date;
}
