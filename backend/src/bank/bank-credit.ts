import { createHash } from 'crypto';
import { AtlasContractError, AtlasMovement, isReversed, normalizeNumericText } from './atlas/atlas-movements';
import { BankTransferSource } from './entities/bank-transfer.entity';

/** Credito del banco normalizado, listo para registrar como BankTransfer. */
export type NormalizedCredit = {
  fingerprint: string;
  source: BankTransferSource;
  accountNumber: string;
  bankDocNumber: string | null;
  bancardTxId: string | null;
  amount: number;
  currency: string;
  movementAt: Date;
  processDate: string | null;
  concept: string;
  senderName: string | null;
  senderDoc: string | null;
  senderAccount: string | null;
  senderNote: string | null;
  txCode: string | null;
  txDescription: string | null;
  /** Banco que envio la transferencia (SWIFT y nombre) y referencia SIPAP de la operacion. */
  senderBankCode: string | null;
  senderBankName: string | null;
  sipapReference: string | null;
  reversed: boolean;
  rawPayload: Record<string, unknown>;
};

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
};

/** Campo fuera del manual: si el banco cambia su forma, se ignora en lugar de frenar el feed. */
const undocumentedText = (value: unknown): string | null => (typeof value === 'string' ? text(value) : null);

/**
 * Banco de origen y referencia SIPAP. El manual v1.1 no los documenta, pero el banco real los manda
 * en `infoAdicional` (verificado el 13/10/2026 en todos los creditos SIPAP de una semana):
 * `cod_swi_ban_remitente` (SWIFT, p. ej. COMAPYPA), `des_swi_ban_remitente` (nombre, p. ej. UENO BANK
 * SOCIEDAD ANONIMA) y `nro_ref_externa` (referencia de la operacion SIPAP). La Consulta de
 * Operaciones SIPAP y el catalogo de bancos, que iban a completar este dato, responden error.
 */
export const senderBankFromInfo = (info: Record<string, unknown> | null | undefined) => ({
  senderBankCode: undocumentedText(info?.cod_swi_ban_remitente),
  senderBankName: undocumentedText(info?.des_swi_ban_remitente),
  sipapReference: undocumentedText(info?.nro_ref_externa),
});

/**
 * Huella del movimiento: solo campos inmutables. Nunca `reversado`, `estado` ni `fecha Proceso`,
 * que el banco puede cambiar; si entraran, el mismo dinero apareceria dos veces y podria tomarse dos veces.
 */
export const computeFingerprint = (c: Pick<NormalizedCredit, 'accountNumber' | 'bankDocNumber' | 'movementAt' | 'amount' | 'currency' | 'txCode' | 'senderAccount'>) =>
  createHash('sha256')
    .update(
      [
        c.accountNumber,
        c.bankDocNumber ?? '',
        c.movementAt.toISOString(),
        c.amount.toFixed(2),
        c.currency.toUpperCase(),
        c.txCode ?? '',
        c.senderAccount ?? '',
      ].join('|'),
    )
    .digest('hex');

export const toNormalizedCredit = (m: AtlasMovement, source: BankTransferSource): NormalizedCredit => {
  const movementAt = new Date(m.fechaMovimiento);
  if (Number.isNaN(movementAt.getTime())) {
    throw new AtlasContractError(`fechaMovimiento invalida: ${m.fechaMovimiento}`);
  }
  const info = m.infoAdicional;
  const bancard = m.nroTransaccionBancard;
  const base = {
    source,
    accountNumber: m.numeroCuenta,
    bankDocNumber: m.nroDocumento,
    bancardTxId: bancard && bancard !== '0' ? bancard : null,
    amount: m.monto,
    currency: m.moneda.trim().toUpperCase(),
    movementAt,
    processDate: text(m.fechaProceso),
    concept: m.concepto,
    senderName: text(info.nom_remitente),
    senderDoc: text(info.nro_doc_remitente),
    senderAccount: text(info.nro_cta_remitente),
    senderNote: text(info.concepto),
    txCode: normalizeNumericText(info.cod_transaccion),
    txDescription: text(info.des_transaccion),
    // Fuera de la huella: agregarlos no puede duplicar transferencias ya registradas.
    ...senderBankFromInfo(info),
    reversed: isReversed(m),
    rawPayload: m.raw,
  };
  return { ...base, fingerprint: computeFingerprint(base) };
};

/** Documento o cuenta visibles solo en parte para cajeros y cobradores: 98****43. */
export const maskIdentifier = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const clean = value.trim();
  if (clean.length <= 4) return '*'.repeat(clean.length);
  return `${clean.slice(0, 2)}${'*'.repeat(Math.max(3, clean.length - 4))}${clean.slice(-2)}`;
};

/** Normaliza el numero de ticket o cliente para que "0045", " 45 " y "45" sean el mismo. */
export const normalizeReference = (value: string): string => {
  const compact = value.replace(/\s+/g, '').toUpperCase();
  if (/^\d+$/.test(compact)) return compact.replace(/^0+(?=\d)/, '');
  return compact;
};
