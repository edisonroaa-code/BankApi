import { attachPaymentControls } from './payment-controls';
import { Payment, PaymentState } from './entities/payment.entity';
import { BankTransferClaim, ClaimStatus } from '../bank/entities/bank-transfer-claim.entity';

describe('Cierre administrativo de conciliaciones API', () => {
  const payment = () => ({ id: 'p-1', isAtlasAccount: true, allocatedAmount: 200000, status: PaymentState.CONFIRMADO,
    cashPaidAt: new Date(), printedAt: new Date() } as Payment);
  const claim = (id: string) => ({ id, paymentId: 'p-1', bankTransferId: `t-${id}`, receiptNumber: `TR-${id}`, amount: 100000, status: ClaimStatus.ACTIVA });
  const load = async (claims: any[], audits: any[]) => {
    const manager = { getRepository: (entity) => ({ find: async () => entity === BankTransferClaim ? claims : audits }) };
    return (await attachPaymentControls(manager as any, [payment()]))[0] as any;
  };
  it('pasar por caja no equivale a revisión del titular', async () => {
    const p = await load([claim('c-1')], []);
    expect(p.adminReview).toMatchObject({ required: true, status: 'PENDING', pendingCount: 1 });
  });
  it('una revisión debe cubrir cada parte activa del pago, incluso si la tomó ADMIN', async () => {
    const p = await load([claim('c-1'), claim('c-2')], [{ action: 'BANK_CLAIM_REVIEWED', paymentId: 'p-1', timestamp: new Date(), actorUsername: 'admin', metadata: '{"claimId":"c-1"}' }]);
    expect(p.adminReview.pendingCount).toBe(1);
    expect(p.adminReview.status).toBe('PENDING');
  });
  it('solo las revisiones explícitas de todas las partes completan la etapa', async () => {
    const time = new Date();
    const p = await load([claim('c-1')], [{ action: 'BANK_CLAIM_REVIEWED', paymentId: 'p-1', timestamp: time, actorUsername: 'titular', metadata: '{"claimId":"c-1","reviewedByName":"Titular de prueba"}' }]);
    expect(p.adminReview).toMatchObject({ status: 'REVIEWED', pendingCount: 0, reviewedAt: time, reviewedBy: 'Titular de prueba' });
  });
  it('sin conciliación activa no se presume revisión de un histórico', async () => {
    const p = await load([], []);
    expect(p.adminReview.status).toBe('PENDING');
  });
});
