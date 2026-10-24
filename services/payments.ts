import { api } from './api';
import { Payment, PaymentState } from '../types';
import { askReprintReason, paymentTicketIssued } from './print-policy';

export type PaymentsPage = {
  items: Payment[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type PaymentsPageParams = {
  workOpen?: boolean;
  pendingAdminReview?: boolean;
  page?: number;
  pageSize?: number;
  statuses?: PaymentState[];
  startDate?: string;
  endDate?: string;
  search?: string;
  globalScope?: boolean;
  isAtlasAccount?: true;
};

export const fetchPaymentsPage = async (params: PaymentsPageParams = {}): Promise<PaymentsPage> => {
  const response = await api.get('/payments/paged', {
    params: {
      workOpen: params.workOpen ? 'true' : undefined,
      pendingAdminReview: params.pendingAdminReview ? 'true' : undefined,
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 50,
      statuses: params.statuses?.join(','),
      startDate: params.startDate,
      endDate: params.endDate,
      search: params.search,
      globalScope: params.globalScope ? 'true' : undefined,
      isAtlasAccount: params.isAtlasAccount ? 'true' : undefined,
    },
  });
  return response.data as PaymentsPage;
};

export const fetchPaymentDetail = async (paymentId: string): Promise<Payment> => {
  const response = await api.get(`/payments/${paymentId}`);
  return response.data as Payment;
};

/** Datos del ticket para el diálogo de impresión; no lo cuenta como impreso. */
export const openPaymentTicket = async (paymentId: string): Promise<Payment> => {
  const current = await fetchPaymentDetail(paymentId);
  const reason = askReprintReason(paymentTicketIssued(current));
  const preview = (await api.post(`/payments/${paymentId}/print-preview`, reason ? { reason } : {})).data as Payment;
  return { ...preview, reprint: (preview.printCopyNumber ?? 1) > 1 };
};

/** La persona confirmó que el ticket salió impreso. */
export const confirmPaymentTicketPrint = async (paymentId: string, authorizationId?: string): Promise<Payment> =>
  (await api.post(`/payments/${paymentId}/print`, { authorizationId })).data as Payment;

export const upsertPayment = (items: Payment[], payment: Payment) => {
  const exists = items.some((item) => item.id === payment.id);
  const next = exists
    ? items.map((item) => (item.id === payment.id ? payment : item))
    : [payment, ...items];
  return next.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
};
