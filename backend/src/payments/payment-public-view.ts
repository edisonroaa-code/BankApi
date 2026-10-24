/** El navegador recibe un recurso de la API, nunca la ubicación real del archivo. */
export function paymentPublicView<T extends { id: string; proofUrl?: string | null }>(payment: T): T {
  if (!payment.proofUrl) return payment;
  return { ...payment, hasProof: true, proofUrl: `/payments/${encodeURIComponent(payment.id)}/proof` };
}
