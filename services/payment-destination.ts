import type { Payment } from '../types';

/**
 * Bancos donde la empresa recibe depositos. Atlas es la cuenta nueva, con API; BNF es la cuenta
 * de siempre, sin API, que convive mientras los clientes se pasan a Atlas. En la base es el
 * booleano `isAtlasAccount` (true = Atlas, false = BNF).
 */
export const DEPOSIT_BANK_OPTIONS = [
  { isAtlasAccount: true, label: 'Atlas', detail: 'Cuenta nueva · se verifica con el banco' },
  { isAtlasAccount: false, label: 'BNF', detail: 'Cuenta de siempre · la aprueba el admin' },
] as const;

/** Sin banco elegido no se guarda la consulta: no hay valor por defecto que se pueda olvidar. */
export const DEPOSIT_BANK_REQUIRED = 'Elegí el banco donde se depositó: Atlas o BNF.';

export const isDepositBankChosen = (isAtlasAccount?: boolean | null): isAtlasAccount is boolean =>
  isAtlasAccount === true || isAtlasAccount === false;

/** Banco donde se deposito, separado del banco de origen del cliente. */
export const destinationLabel = (isAtlasAccount?: boolean | null): string =>
  isAtlasAccount === true
    ? 'Atlas · API'
    : isAtlasAccount === false
      ? 'BNF · manual'
      : 'Banco de depósito sin elegir';

/** Sin clasificación explícita no se elige ningún flujo de aprobación. */
export const canUseManualFlow = (isAtlasAccount?: boolean | null): boolean => isAtlasAccount === false;

export const canUseApiFlow = (isAtlasAccount?: boolean | null): boolean => isAtlasAccount === true;

/** El ticket describe solo la forma de confirmación sustentada por el estado persistido. */
export const ticketVerificationLabel = (payment: Pick<Payment, 'status' | 'isAtlasAccount' | 'allocatedAmount'>): string => {
  if (payment.status === 'CONFIRMADO_MANUAL') return 'APROBACIÓN MANUAL';
  if (payment.status === 'CONFIRMADO' && payment.isAtlasAccount === true && Number(payment.allocatedAmount ?? 0) > 0) {
    return 'CONCILIACIÓN CON MOVIMIENTO';
  }
  if (payment.status === 'CONFIRMADO') return 'CONFIRMACIÓN REGISTRADA';
  return 'SIN CONFIRMACIÓN';
};
