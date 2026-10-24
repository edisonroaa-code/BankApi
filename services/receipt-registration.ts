import type { BankReceipt, BankTransfer } from '../types';

export const bankReceiptSourceLabel = (source?: BankReceipt['source']): string =>
  source === 'ATLAS' ? 'ATLAS CONNECT · API' : source === 'MOCK' ? 'DATOS DE PRUEBA · MOCK' : 'FUENTE NO INFORMADA';

export const bankReceiptTitle = (referenceType: BankReceipt['referenceType']): string =>
  referenceType === 'CONSULTA' ? 'CONSULTA CONCILIADA' : 'TRANSFERENCIA TOMADA';

export const claimIdForPayment = (
  transfer: Pick<BankTransfer, 'claims'>,
  paymentId: string,
): string => {
  const claim = transfer.claims.find((item) => item.paymentId === paymentId && item.status === 'ACTIVA');
  if (!claim) throw new Error('No se encontró la toma activa de esta consulta para registrar la impresión.');
  return claim.id;
};

/**
 * Un comprobante solo se muestra si el servidor pudo auditar que se abre el diálogo. Contarlo como
 * impreso es otro paso: la persona lo confirma al cerrar el diálogo.
 */
export const registerAndDisplayReceipt = async (
  register: () => Promise<BankReceipt>,
  display: (receipt: BankReceipt) => void,
): Promise<BankReceipt> => {
  const receipt = await register();
  display(receipt);
  return receipt;
};
