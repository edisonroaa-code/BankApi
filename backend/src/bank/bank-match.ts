import { cents } from './bank-allocation';
import { senderBankFromInfo } from './bank-credit';

/**
 * Evidencia que une una transferencia del banco con una consulta de cobrador.
 * El monto por si solo no alcanza: en SPI los montos redondos se repiten todo el dia, y varias
 * consultas del mismo valor son indistinguibles. Se evalúan identidad, monto y contexto.
 */
export enum MatchEvidence {
  /** La referencia que cargo el cobrador es el numero de operacion de esta transferencia. */
  REFERENCIA = 'REFERENCIA',
  REFERENCIA_PARCIAL = 'REFERENCIA_PARCIAL',
  /** El concepto que escribio quien envio contiene la referencia o el codigo del cliente. */
  CONCEPTO = 'CONCEPTO',
  /** Esa cuenta remitente ya pago antes a este mismo cliente, con conciliacion confirmada. */
  CUENTA_CONOCIDA = 'CUENTA_CONOCIDA',
  /** El nombre del remitente se parece al del cliente. */
  NOMBRE = 'NOMBRE',
  /** Coincide el monto total o el saldo pendiente. Nunca suficiente por sí solo. */
  MONTO = 'MONTO',
  /** La transferencia alcanza para cubrir lo que falta de la consulta, sin ser el monto exacto. */
  MONTO_PARCIAL = 'MONTO_PARCIAL',
  /** Entro cerca de la hora en que se cargo la consulta. */
  CERCANIA = 'CERCANIA',
  BANCO = 'BANCO',
  FECHA = 'FECHA',
}

export type MatchStrength = 'FUERTE' | 'MEDIA' | 'DEBIL';

export type MatchAssessment = {
  evidence: MatchEvidence[];
  conflicts: string[];
  strength: MatchStrength;
  /** Para ordenar candidatos: mayor es mejor. */
  score: number;
  /** Frase corta para mostrar al lado del candidato. */
  reason: string;
};

export type MatchableTransfer = {
  amount: number | string;
  allocatedAmount: number | string;
  movementAt: Date | string;
  bankDocNumber?: string | null;
  sipapReference?: string | null;
  bancardTxId?: string | null;
  senderAccount?: string | null;
  senderName?: string | null;
  senderNote?: string | null;
  concept?: string | null;
  senderBankName?: string | null;
  currency?: string | null;
  status?: string;
  rawPayload?: unknown;
};

export type MatchablePayment = {
  amount: number | string;
  allocatedAmount: number | string;
  createdAt: Date | string;
  paymentRef?: string | null;
  clientCode?: string | null;
  clientName?: string | null;
  sourceBank?: string | null;
  isAtlasAccount?: boolean | null;
  currency?: string | null;
};

const HOUR = 60 * 60 * 1000;

/** Normaliza para comparar: sin espacios ni signos, mayusculas, sin ceros a la izquierda. */
const text = (value?: string | null) => (value ?? '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const key = (value?: string | null) => text(value).replace(/[^A-Z0-9]/g, '').replace(/^0+(?=.)/, '');

// Un sufijo puede venir de un comprobante abreviado; nunca equivale a una operación exacta.
const referenceSuffix = (ref: string, other: string) =>
  /^\d{5,}$/.test(ref) && /^\d+$/.test(other) && other.length > ref.length && other.endsWith(ref);

const textContains = (haystack: string | null | undefined, needle: string) => {
  if (needle.length < 4) return false;
  const words = text(haystack).match(/[A-Z0-9]+/g) ?? [];
  // Permite CL-1012 y CL 1012, pero 7098 nunca identifica a 1709800.
  return words.some((_, i) => [1, 2, 3].some((n) => key(words.slice(i, i + n).join('')) === needle));
};

/** Compara nombres por palabras significativas: "MARIA BENITEZ" contra "BENITEZ, MARIA E." */
const nameLooksLike = (a?: string | null, b?: string | null) => {
  const words = (v?: string | null) => new Set(text(v).split(/[^A-Z]+/).filter((w) => w.length >= 3 && !['DEL', 'LOS', 'LAS'].includes(w)));
  const left = words(a), right = words(b);
  if (left.size < 2 || right.size < 2) return false;
  const hits = [...left].filter((w) => right.has(w)).length;
  return hits >= 2 && hits / left.size >= 0.75 && hits / right.size >= 0.75;
};

const bankKey = (value?: string | null) => {
  const words = text(value).split(/[^A-Z0-9]+/).filter((w) => w && !['BANCO', 'BANK', 'SOCIEDAD', 'ANONIMA', 'SA', 'SAECA', 'S', 'A', 'E', 'C', 'DE', 'DEL', 'EL'].includes(w));
  const bank = words.join(' ');
  return ['NACIONAL FOMENTO', 'B N F'].includes(bank) ? 'BNF' : bank;
};

/** Una numeración de cuenta puede existir en distintos bancos. Sin banco no se infiere historial. */
export const senderAccountKey = (transfer: Pick<MatchableTransfer, 'senderAccount' | 'senderBankName' | 'rawPayload'>) => {
  const raw = senderBankFromInfo((transfer.rawPayload as { infoAdicional?: Record<string, unknown> } | undefined)?.infoAdicional);
  const bank = bankKey(transfer.senderBankName ?? raw.senderBankName);
  return bank && transfer.senderAccount ? `${bank}|${transfer.senderAccount.trim()}` : '';
};

const CONFLICT_REASONS: Record<string, string> = {
  DESTINO: 'El depósito es BNF y este movimiento ingresó a Atlas.',
  BANCO: 'El banco de origen es diferente.',
  MONEDA: 'La moneda es diferente.',
  FECHA: 'La fecha del movimiento queda fuera del rango de la consulta.',
  ESTADO: 'El movimiento está bloqueado o reversado.',
};

/**
 * Evalua una pareja candidata. `knownClientCode` es el cliente que esa cuenta remitente ya pago
 * antes, segun conciliaciones confirmadas (lo aporta quien llama, desde el historial).
 */
export const assessMatch = (
  transfer: MatchableTransfer,
  payment: MatchablePayment,
  knownClientCode?: string | null,
): MatchAssessment => {
  const evidence: MatchEvidence[] = [];
  const conflicts: string[] = [];
  let score = 0;

  const raw = senderBankFromInfo((transfer.rawPayload as { infoAdicional?: Record<string, unknown> } | undefined)?.infoAdicional);
  const bank = bankKey(transfer.senderBankName ?? raw.senderBankName);
  const sourceBank = bankKey(payment.sourceBank);
  if (payment.isAtlasAccount === false) conflicts.push('DESTINO');
  if (bank && sourceBank) {
    const same = bank === sourceBank || bank.split(' ').every((w) => sourceBank.split(' ').includes(w)) || sourceBank.split(' ').every((w) => bank.split(' ').includes(w));
    if (same) { evidence.push(MatchEvidence.BANCO); score += 15; }
    else conflicts.push('BANCO');
  }
  if (transfer.currency && payment.currency && key(transfer.currency) !== key(payment.currency)) conflicts.push('MONEDA');
  if (['REVERSADA', 'BLOQUEADA'].includes(transfer.status ?? '')) conflicts.push('ESTADO');

  const transferRemaining = cents(transfer.amount) - cents(transfer.allocatedAmount);
  const paymentRemaining = cents(payment.amount) - cents(payment.allocatedAmount);

  const ref = key(payment.paymentRef);
  if (ref) {
    const references = [transfer.bankDocNumber, transfer.sipapReference ?? raw.sipapReference, transfer.bancardTxId].map(key).filter(Boolean);
    if (references.includes(ref)) {
      evidence.push(MatchEvidence.REFERENCIA);
      score += 1000;
    } else if (references.some((other) => referenceSuffix(ref, other))) {
      evidence.push(MatchEvidence.REFERENCIA_PARCIAL);
      score += 15;
    }
    if (textContains(transfer.senderNote, ref) || textContains(transfer.concept, ref)) {
      evidence.push(MatchEvidence.CONCEPTO);
      score += 80;
    }
  }

  const clientCode = key(payment.clientCode);
  if (!evidence.includes(MatchEvidence.CONCEPTO) && clientCode && (textContains(transfer.senderNote, clientCode) || textContains(transfer.concept, clientCode))) {
    evidence.push(MatchEvidence.CONCEPTO);
    score += 60;
  }

  if (transfer.senderAccount && knownClientCode && payment.clientCode && key(knownClientCode) === clientCode) {
    evidence.push(MatchEvidence.CUENTA_CONOCIDA);
    score += 70;
  }

  if (nameLooksLike(payment.clientName, transfer.senderName)) {
    evidence.push(MatchEvidence.NOMBRE);
    score += 25;
  }

  if ((transferRemaining === paymentRemaining && paymentRemaining > 0) ||
      (transferRemaining === 0 && cents(transfer.amount) === cents(payment.amount) && cents(payment.amount) > 0)) {
    evidence.push(MatchEvidence.MONTO);
    score += 20;
  } else if (transferRemaining > 0 && paymentRemaining > 0) {
    evidence.push(MatchEvidence.MONTO_PARCIAL);
    score += 5;
  }

  const hours = Math.abs(new Date(transfer.movementAt).getTime() - new Date(payment.createdAt).getTime()) / HOUR;
  if (hours <= 24) { evidence.push(MatchEvidence.FECHA); score += 10; }
  // createdAt es la carga del cobrador, no la fecha del comprobante: admite cargas tardías.
  if (hours > 5 * 24) conflicts.push('FECHA');
  if (hours <= 2) {
    evidence.push(MatchEvidence.CERCANIA);
    score += 10;
  } else if (hours <= 24) {
    score += 4;
  }

  const has = (item: MatchEvidence) => evidence.includes(item);
  const strong = conflicts.length === 0 && (
    evidence.includes(MatchEvidence.REFERENCIA) ||
    (has(MatchEvidence.CONCEPTO) && has(MatchEvidence.MONTO) && (has(MatchEvidence.FECHA) || has(MatchEvidence.BANCO))) ||
    (evidence.includes(MatchEvidence.CUENTA_CONOCIDA) && evidence.includes(MatchEvidence.MONTO)) ||
    (has(MatchEvidence.NOMBRE) && has(MatchEvidence.MONTO) && has(MatchEvidence.BANCO) && has(MatchEvidence.FECHA)));
  const medium = conflicts.length === 0 && (
    has(MatchEvidence.CONCEPTO) ||
    evidence.includes(MatchEvidence.CUENTA_CONOCIDA) ||
    (evidence.includes(MatchEvidence.NOMBRE) && evidence.includes(MatchEvidence.MONTO)));

  return {
    evidence,
    conflicts,
    strength: strong ? 'FUERTE' : medium ? 'MEDIA' : 'DEBIL',
    score: (strong ? 10000 : medium ? 5000 : 0) + score - conflicts.length * 400,
    reason: [describeEvidence(evidence), ...conflicts.map((c) => CONFLICT_REASONS[c])].join(' '),
  };
};

export const describeEvidence = (evidence: MatchEvidence[]): string => {
  const labels: Record<MatchEvidence, string> = {
    REFERENCIA: 'referencia completa', REFERENCIA_PARCIAL: 'terminación de referencia (parcial)',
    CONCEPTO: 'referencia o código de cliente en el concepto', CUENTA_CONOCIDA: 'cuenta que ya pagó a este cliente',
    NOMBRE: 'nombre del remitente', MONTO: 'monto', MONTO_PARCIAL: 'monto parcial',
    BANCO: 'banco de origen', FECHA: 'fecha dentro de 24 h de la carga', CERCANIA: 'hora cercana a la carga',
  };
  const identity = evidence.some((e) => [MatchEvidence.REFERENCIA, MatchEvidence.CONCEPTO, MatchEvidence.CUENTA_CONOCIDA, MatchEvidence.NOMBRE].includes(e));
  return `${identity ? 'Coinciden' : 'Sin identidad confirmada; coinciden'}: ${evidence.map((e) => labels[e]).join(', ') || 'sin datos suficientes'}.${identity ? '' : ' Revisá el comprobante.'}`;
};

/** Ordena candidatos de mejor a peor, con la evaluacion ya calculada. */
export const rankByMatch = <T>(items: Array<T & { match: MatchAssessment }>) =>
  [...items].sort((a, b) => b.match.score - a.match.score);
