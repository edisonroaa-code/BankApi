import type { BankClaim, Payment } from '../types';

export const canIssueTicket = (role: string, issued: boolean) => role === 'ADMIN' || !issued;
export const paymentTicketIssued = (payment: Pick<Payment, 'printedAt' | 'ticketIssued'>) => !!payment.printedAt || !!payment.ticketIssued;
export const canPrintClaim = (claim: BankClaim, userId: string, role: string) =>
  claim.status === 'ACTIVA' && (role === 'ADMIN' || (claim.claimedById === userId && canIssueTicket(role, claim.printCount > 0 || !!claim.printIssued)));

export class PrintPolicyError extends Error { readonly userMessage = this.message; }

/** Solo facilita la UI; la autorización siempre la vuelve a comprobar el servidor. */
export const askReprintReason = (issued: boolean): string | undefined => {
  if (!issued) return undefined;
  let role: string | undefined;
  try { role = JSON.parse(localStorage.getItem('bnf_app_session_v2') || '{}').user?.role; } catch { /* Sin sesión: denegar. */ }
  if (role !== 'ADMIN') throw new PrintPolicyError('El ticket ya fue emitido. Solo ADMIN puede reimprimirlo.');
  const reason = window.prompt('Motivo de la reimpresión autorizada por ADMIN (10 a 500 caracteres):')?.trim();
  if (!reason) throw new PrintPolicyError('Reimpresión cancelada.');
  if (reason.length < 10 || reason.length > 500) throw new PrintPolicyError('Indicá un motivo de entre 10 y 500 caracteres.');
  return reason;
};
