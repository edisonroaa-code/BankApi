export enum UserRole {
  ADMIN = 'ADMIN',
  SUPERVISOR = 'SUPERVISOR',
  COBRADOR = 'COBRADOR',
  CAJERO = 'CAJERO',
}

export interface User {
  id: string;
  name: string;
  username: string; // Login username
  role: UserRole;
  isActive: boolean;
}

export enum PaymentState {
  PENDIENTE_VERIFICACION = 'PENDIENTE_VERIFICACION',
  EN_REVISION = 'EN_REVISION',
  CONFIRMADO = 'CONFIRMADO',
  CONFIRMADO_MANUAL = 'CONFIRMADO_MANUAL',
  RECHAZADO = 'RECHAZADO',
}

export interface Payment {
  ticketIssued?: boolean;
  printAuthorizationId?: string;
  printCopyNumber?: number;
  reprintReason?: string | null;
  adminReview?: {
    required: boolean;
    status: 'PENDING' | 'REVIEWED';
    totalCount: number;
    pendingCount: number;
    reviewedAt: string | null;
    reviewedBy: string | null;
    claims: Array<{ claimId: string; transferId: string; receiptNumber: string; amount: number; reviewedAt: string | null; reviewedBy: string | null }>;
  };
  id: string;
  createdById?: string;
  amount: number;
  /** Cuánto de la consulta ya está cubierto por transferencias del banco. */
  allocatedAmount?: number;
  currency: string;
  clientName?: string;
  clientCode?: string; // Nuevo: Código interno del cliente
  paymentRef?: string; // Nuevo: Número de referencia/boleta manual
  sourceBank?: string; // Nuevo: Entidad Financiera
  /** Banco donde se depositó: true = Atlas (API), false = BNF (manual), null = consulta anterior sin elegir. */
  isAtlasAccount?: boolean | null;
  observation?: string;
  proofUrl?: string; // Data URL for image
  hasProof?: boolean;
  cashPaidAt?: string | null;
  cashPaidById?: string | null;
  cashPaidByUsername?: string | null;
  cashPaidByName?: string | null;
  reviewClaimedById?: string | null;
  reviewClaimedByUsername?: string | null;
  reviewClaimedByName?: string | null;
  reviewClaimedAt?: string | null;
  reviewClaimExpiresAt?: string | null;
  verifiedById?: string | null;
  verifiedByUsername?: string | null;
  verifiedByName?: string | null;
  verifiedAt?: string | null; // ISO Date
  createdAt: string; // ISO Date
  createdBy: string | User; // User ID or User Object
  status: PaymentState;
  matchedMovementId?: string;
  rejectionReason?: string;
  decisionReason?: string | null;
  printedAt?: string; // ISO Date of printing
  reprint?: boolean;
}

export interface AuditLog {
  id: string;
  userId: string;
  actorUsername?: string | null;
  action: string;
  beforeState?: PaymentState | null;
  afterState?: PaymentState | null;
  timestamp: string;
  metadata?: string;
  paymentId?: string | null;
  movementId?: string | null;
  targetUserId?: string | null;
  bankTransferId?: string | null;
  /** Contexto para leer el registro sin códigos (lo agrega el servidor). */
  actorName?: string | null;
  targetUserName?: string | null;
  payment?: {
    id: string;
    amount: number;
    currency?: string | null;
    clientName?: string | null;
    clientCode?: string | null;
    paymentRef?: string | null;
    sourceBank?: string | null;
    isAtlasAccount?: boolean | null;
    collectorName?: string | null;
  } | null;
  bankTransfer?: {
    id: string;
    amount: number;
    currency?: string | null;
    bankDocNumber?: string | null;
    movementAt?: string | null;
  } | null;
}

export interface PaymentSummary {
  status: PaymentState;
  count: number;
  total: number;
}

export enum BankTransferStatus {
  DISPONIBLE = 'DISPONIBLE',
  /** Una parte ya fue tomada y todavía queda saldo libre. */
  PARCIAL = 'PARCIAL',
  TOMADA = 'TOMADA',
  REVERSADA = 'REVERSADA',
  BLOQUEADA = 'BLOQUEADA',
}

export type ClaimReferenceType = 'TICKET' | 'CLIENTE' | 'CONSULTA';

/** Con qué evidencia se armó la pareja consulta <-> transferencia. */
export type MatchStrength = 'FUERTE' | 'MEDIA' | 'DEBIL';

export type MatchEvidence =
  | 'REFERENCIA'
  | 'REFERENCIA_PARCIAL'
  | 'CONCEPTO'
  | 'CUENTA_CONOCIDA'
  | 'NOMBRE'
  | 'MONTO'
  | 'MONTO_PARCIAL'
  | 'CERCANIA'
  | 'BANCO'
  | 'FECHA';

export interface MatchAssessment {
  evidence: MatchEvidence[];
  conflicts?: string[];
  strength: MatchStrength;
  score: number;
  reason: string;
}

export interface BankClaim {
  printIssued?: boolean;
  id: string;
  receiptNumber: string;
  /** Parte del monto de la transferencia que consume esta toma. */
  amount: number;
  referenceType: ClaimReferenceType;
  referenceValue: string;
  note: string | null;
  claimedById: string;
  claimedByName: string | null;
  claimedByUsername: string | null;
  claimedByRole: string;
  claimedAt: string;
  status: 'ACTIVA' | 'ANULADA';
  printCount: number;
  paymentId: string | null;
  paymentRef: string | null;
  clientName: string | null;
  /** Código de cliente que cargó el cobrador en la consulta. */
  clientCode?: string | null;
  collectorName: string | null;
  matchStrength: MatchStrength | null;
  matchEvidence: string | null;
  voidedByName?: string | null;
  voidedAt?: string | null;
  voidReason?: string | null;
}

/** Transferencia entrante vista en el banco (sin saldos: el panel no muestra dinero de la cuenta). */
export interface BankTransfer {
  id: string;
  source: 'ATLAS' | 'MOCK';
  bankDocNumber: string | null;
  amount: number;
  /** Suma de las tomas activas. */
  allocatedAmount: number;
  /** Lo que todavía se puede tomar. */
  availableAmount: number;
  currency: string;
  movementAt: string;
  concept: string;
  senderName: string | null;
  senderDoc: string | null;
  senderAccount: string | null;
  senderNote: string | null;
  /** Banco de origen: se completa con la Consulta de Operaciones SIPAP si hay vinculo unico. */
  senderBankCode: string | null;
  senderBankName: string | null;
  channel: string | null;
  sipapReference: string | null;
  sipapReason: string | null;
  txDescription: string | null;
  status: BankTransferStatus;
  reversedAt: string | null;
  blockedReason: string | null;
  firstSeenAt: string;
  /** Tomas activas, de la más reciente a la más vieja. Vacío si nadie la tomó. */
  claims: BankClaim[];
  /** Evidencia del calce contra una consulta puntual (solo al pedir candidatas). */
  match?: MatchAssessment;
}

export interface BankReceipt {
  printAuthorizationId?: string;
  printScope?: 'PAYMENT' | 'CLAIM';
  printCopyNumber?: number;
  reprintReason?: string | null;
  /** Para confirmar la impresión después del diálogo (ausente en servidores anteriores). */
  transferId?: string;
  claimId?: string;
  receiptNumber: string;
  /** Fuente persistida del movimiento; ausente en recibos históricos anteriores al campo. */
  source?: 'ATLAS' | 'MOCK' | null;
  claimedAt: string;
  claimedByName: string | null;
  claimedByUsername: string | null;
  claimedByRole: string;
  referenceType: ClaimReferenceType;
  referenceValue: string;
  paymentRef: string | null;
  /** Consulta conciliada (ausente en una toma de caja). */
  paymentId?: string | null;
  /** Consulta conciliada: datos que cargó el cobrador. */
  clientName?: string | null;
  clientCode?: string | null;
  collectorName?: string | null;
  /** Monto tomado por este comprobante. */
  amount: number;
  /** Monto total de la transferencia: si difiere, fue una toma parcial. */
  transferAmount: number;
  currency: string;
  senderName: string | null;
  bankDocNumber: string | null;
  movementAt: string;
  printCount: number;
  voided: boolean;
}

/** Pestañas del panel de transferencias. */
export type BankListView = 'DISPONIBLES' | 'TOMADAS' | 'REVISAR' | 'TODAS';

/** Una página del panel por mes. */
export interface BankTransfersPage {
  month: string;
  view: BankListView;
  items: BankTransfer[];
  total: number;
  page: number;
  pageSize: number;
  /** Cantidad por pestaña en el mes, sin la búsqueda. */
  counts: Record<BankListView, number>;
  /** Sin tomar en otros meses: el panel avisa para que no queden olvidadas. */
  pendingOtherMonths: Array<{ month: string; count: number }>;
}

/** Saldo de la cuenta Atlas: solo lo ve el admin y a pedido. */
export interface BankBalance {
  balance: {
    nroCuenta: string;
    producto: { codigo: number; descripcion: string; descripcionCorta: string | null };
    moneda: string;
    saldo: number;
    saldoDisponible: number;
    depositoConfirmar: number | null;
    saldoBloqueado: number | null;
    saldoProtegido: number | null;
    saldoPromedio: number | null;
  };
  verified: boolean;
  simulated: boolean;
  consultedAt: string;
}

export type BankFeedState = 'APAGADO' | 'EN_ESPERA' | 'FUERA_DE_HORARIO' | 'EN_VIVO' | 'ERROR' | 'DETENIDO' | 'SIN_CONFIGURAR';

export interface BankFeedStatus {
  mode: string;
  state: BankFeedState;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  verified: boolean;
  intervalSeconds: number;
  hours: string;
  /** Inicio de la última consulta al banco (automática o pedida con "Actualizar"). */
  lastPollAt?: string | null;
  /** Quién pidió la última actualización manual; null si fue automática. */
  lastRefreshBy?: string | null;
  /** Espera compartida entre consultas al banco, igual para todas las pantallas. */
  refreshCooldownSeconds?: number;
  /** Hora del servidor al enviar el estado: la cuenta regresiva no depende del reloj de cada PC. */
  serverTime?: string;
  /** Transferencias registradas o reversadas por el feed desde que arrancó el servidor. */
  changeCount?: number;
  /** Solo en el navegador: hora del servidor menos la de esta PC, medida al recibir el estado. */
  clockOffsetMs?: number;
}

export type BankRefreshRejection = 'RECIENTE' | 'EN_CURSO' | 'FUERA_DE_HORARIO' | 'DETENIDO' | 'REINTENTANDO' | 'SIN_PANEL';

/** Conciliación que el admin debería mirar: la hizo un cobrador o se cerró sin evidencia. */
export interface ClaimToReview extends BankClaim {
  transferId: string;
  transferAmount: number;
  senderName: string | null;
  bankDocNumber: string | null;
  movementAt: string | null;
}

export interface CandidatePayment {
  id: string;
  isAtlasAccount?: boolean | null;
  paymentRef: string | null;
  clientName: string | null;
  clientCode: string | null;
  sourceBank: string | null;
  amount: number;
  /** Cuánto de la consulta ya está cubierto por transferencias. */
  allocatedAmount: number;
  /** Lo que falta cubrir. */
  pendingAmount: number;
  status: PaymentState;
  createdAt: string;
  collectorName: string | null;
  collectorId: string;
  match?: MatchAssessment;
}
