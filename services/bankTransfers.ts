import { api } from './api';
import { claimIdForPayment } from './receipt-registration';
import { askReprintReason, paymentTicketIssued } from './print-policy';
import { fetchPaymentDetail } from './payments';
import { BankBalance, BankClaim, BankFeedStatus, BankListView, BankRefreshRejection, BankReceipt, BankTransfer, BankTransfersPage, BankTransferStatus, CandidatePayment, ClaimToReview } from '../types';

export const newOperationKey = (): string => {
  if (typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function') return (crypto as any).randomUUID();
  // Respaldo para navegadores sin randomUUID (contexto no seguro en LAN): UUID v4.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
};

export const fetchBankTransfers = async (params: { date?: string; status?: BankTransferStatus; search?: string } = {}) =>
  (await api.get('/bank-transfers', { params })).data as BankTransfer[];

export const fetchMyClaims = async (date: string) =>
  (await api.get('/bank-transfers/claims/mine', { params: { date } })).data as BankTransfer[];

/** Panel por mes, paginado; trae los contadores por pestaña y lo pendiente de otros meses. */
export const fetchBankTransfersPage = async (params: { month?: string; view?: BankListView; page?: number; pageSize?: number; search?: string }) =>
  (await api.get('/bank-transfers/page', { params })).data as BankTransfersPage;

/** Mis tomas o conciliaciones de un mes ("YYYY-MM"). */
export const fetchMyClaimsByMonth = async (month: string) =>
  (await api.get('/bank-transfers/claims/mine', { params: { month } })).data as BankTransfer[];

export const fetchBankTransfer = async (id: string) => (await api.get(`/bank-transfers/${id}`)).data as BankTransfer;

/** Cola de revisión del admin: conciliaciones de cobradores y cierres sin evidencia. */
export const fetchClaimsToReview = async (params: { days?: number; onlyWeak?: boolean } = {}) =>
  (await api.get('/bank-transfers/claims/review', { params })).data as ClaimToReview[];

export const fetchBankFeedStatus = async () => (await api.get('/bank-feed/status')).data as BankFeedStatus;

/** "Actualizar": pide una consulta al banco compartida por todas las pantallas (espera de 10 s en el servidor). */
export const requestBankRefresh = async () =>
  (await api.post('/bank-feed/refresh')).data as { accepted: boolean; reason?: BankRefreshRejection; status: BankFeedStatus };

/** Saldo de la cuenta: solo admin, a pedido. */
export const fetchBankBalance = async () => (await api.get('/bank-feed/balance')).data as BankBalance;

export const resumeBankFeed = async () => (await api.post('/bank-feed/resume')).data as BankFeedStatus;

export const claimBankTransfer = async (
  id: string,
  body: {
    referenceType: 'TICKET' | 'CLIENTE';
    referenceValue: string;
    idempotencyKey: string;
    note?: string;
    /** Toma parcial: sin esto se toma todo el saldo libre. */
    amount?: number;
    /** Confirma seguir aunque esa referencia ya tenga un cobro. */
    confirmReuse?: boolean;
  },
) => (await api.post(`/bank-transfers/${id}/claim`, body)).data as { transfer: BankTransfer; receipt: BankReceipt };

/**
 * Datos del comprobante para el diálogo de impresión. No lo cuenta como impreso: eso se confirma
 * después, cuando la persona responde que salió (`confirmBankReceiptPrint`).
 */
export const openBankReceipt = async (id: string, claimId?: string) => {
  const current = await fetchBankTransfer(id);
  const claim = current.claims.find((c) => claimId ? c.id === claimId : current.claims.length === 1);
  if (!claim) throw new Error('Elegí el comprobante exacto que querés imprimir.');
  const payment = claim.paymentId ? await fetchPaymentDetail(claim.paymentId) : null;
  const issued = claim.printCount > 0 || !!claim.printIssued || (payment && paymentTicketIssued(payment));
  const reason = askReprintReason(!!issued);
  return (await api.post(`/bank-transfers/${id}/print-preview`, { claimId: claim.id, ...(reason ? { reason } : {}) })).data as BankReceipt;
};

/** La persona confirmó que el comprobante salió impreso. */
export const confirmBankReceiptPrint = async (id: string, claimId: string, authorizationId?: string) =>
  (await api.post(`/bank-transfers/${id}/print`, { claimId, authorizationId })).data as BankReceipt;

/** El admin revisó una conciliación de la cola y está bien: sale de la cola sin anular nada. */
export const markClaimReviewed = async (id: string, claimId: string) =>
  (await api.post(`/bank-transfers/${id}/review`, { claimId })).data as { claimId: string; reviewed: true };

export const voidBankClaim = async (id: string, reason: string, claimId: string) =>
  (await api.post(`/bank-transfers/${id}/void`, { reason, claimId })).data as BankTransfer;

export const releaseBankTransfer = async (id: string, reason: string) =>
  (await api.post(`/bank-transfers/${id}/release`, { reason })).data as BankTransfer;

export const reconcileBankTransfer = async (id: string, paymentId: string, idempotencyKey: string, amount?: number) =>
  (await api.post(`/bank-transfers/${id}/reconcile`, { paymentId, idempotencyKey, ...(amount ? { amount } : {}) })).data as BankTransfer;

export const fetchCandidatePayments = async (id: string) =>
  (await api.get(`/bank-transfers/${id}/candidate-payments`)).data as CandidatePayment[];

export const fetchBankMatchesForPayment = async (paymentId: string) =>
  (await api.get('/bank-transfers/matches', { params: { paymentId } })).data as BankTransfer[];

export const fetchBankTransferHistory = async (id: string) =>
  (await api.get(`/bank-transfers/${id}/history`)).data as {
    transfer: BankTransfer;
    rawPayload: Record<string, unknown>;
    claims: BankClaim[];
    audit: Array<{ id: string; action: string; actorUsername?: string | null; userId: string; timestamp: string; metadata?: string | null }>;
  };

/**
 * Comprobante de la conciliacion recien hecha sobre una consulta. Se cuenta como impreso recien
 * cuando la persona confirma que salio; ese mismo comprobante es el ticket de la consulta.
 */
export const openReconciliationReceipt = async (transfer: BankTransfer, paymentId: string) => {
  return openBankReceipt(transfer.id, claimIdForPayment(transfer, paymentId));
};

export const upsertBankTransfer = (items: BankTransfer[], item: BankTransfer) => {
  const exists = items.some((x) => x.id === item.id);
  const next = exists ? items.map((x) => (x.id === item.id ? item : x)) : [item, ...items];
  return next.sort((a, b) => new Date(b.movementAt).getTime() - new Date(a.movementAt).getTime());
};

export const apiErrorMessage = (error: any, fallback: string) => {
  if (typeof error?.userMessage === 'string') return error.userMessage;
  const message = error?.response?.data?.message;
  if (Array.isArray(message)) return message.join(' ');
  return message ? String(message) : fallback;
};
