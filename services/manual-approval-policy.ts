import type { BankTransfer, Payment } from '../types';

/** Alerta preliminar de la UI; el backend vuelve a validar bajo transaccion. */
export const assessManualApproval = (
  payment: Pick<Payment, 'allocatedAmount'> & Partial<Pick<Payment, 'isAtlasAccount'>>,
  matches: BankTransfer[],
) => {
  const relevant = payment.isAtlasAccount === false ? [] : matches.filter((transfer) => !transfer.match?.conflicts?.length);
  const blocks = (transfer: BankTransfer) => transfer.match?.evidence?.some((item) => item === 'REFERENCIA' || item === 'CONCEPTO');
  return {
    partialBankAllocation: Number(payment.allocatedAmount ?? 0) > 0,
    blockingMatches: relevant.filter(blocks),
    claimedNonBlockingMatches: relevant.filter((transfer) =>
      !blocks(transfer) &&
      transfer.match?.evidence?.some((item) => item === 'CUENTA_CONOCIDA' || item === 'NOMBRE') &&
      transfer.match?.evidence?.includes('MONTO') &&
      transfer.claims?.some((claim) => claim.status === 'ACTIVA'),
    ),
  };
};

export const canBeginManualApproval = (
  payment: Pick<Payment, 'allocatedAmount' | 'isAtlasAccount'>,
  matches: BankTransfer[] | null,
  error: string | null,
): boolean => {
  if (payment.isAtlasAccount !== false || matches === null || error) return false;
  const risk = assessManualApproval(payment, matches);
  return !risk.partialBankAllocation && risk.blockingMatches.length === 0;
};
