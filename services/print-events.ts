import type { Payment } from '../types';

/**
 * Aviso dentro de la app: una consulta quedó confirmada como impresa. La confirmación ocurre en
 * App (diálogo "¿Salió impreso?"), lejos de la pantalla que abrió el ticket; sin este aviso, esa
 * pantalla seguía mostrando "Imprimir" y no habilitaba "Marcar pago en caja", y se imprimía dos
 * veces. No depende del tiempo real: llega aunque el socket esté caído.
 */
type Listener = (payment: Payment) => void;

const listeners = new Set<Listener>();
const issueListeners = new Set<(id: string) => void>();
export const onTicketIssued = (listener: (id: string) => void) => {
  issueListeners.add(listener);
  return () => { issueListeners.delete(listener); };
};
export const notifyTicketIssued = (id: string) => {
  for (const listener of [...issueListeners]) { try { listener(id); } catch { /* Continúan las demás pantallas. */ } }
};

export const onPaymentPrinted = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const notifyPaymentPrinted = (payment: Payment): void => {
  for (const listener of [...listeners]) {
    try {
      listener(payment);
    } catch {
      // Una pantalla con error no impide que las demás se actualicen.
    }
  }
};
