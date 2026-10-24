import { PaymentsService } from './payments.service';
import { PaymentState } from './entities/payment.entity';
import { BankTransfer } from '../bank/entities/bank-transfer.entity';
import { User, UserRole } from '../users/entities/user.entity';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const PAYMENT_ID = '33333333-3333-4333-8333-333333333333';
const TRANSFER_ID = '44444444-4444-4444-8444-444444444444';

const makeService = (logs: any[]) => {
  const query: any = {
    orderBy: () => query, take: () => query, skip: () => query, andWhere: () => query,
    getManyAndCount: async () => [logs, logs.length],
  };
  const auditRepo = { createQueryBuilder: () => query, find: jest.fn().mockResolvedValue(logs) };
  const transferRepo = { find: jest.fn().mockResolvedValue([{ id: TRANSFER_ID, amount: '319000.00', currency: 'PYG', bankDocNumber: '25895', movementAt: new Date('2026-10-13T20:20:00Z') }]) };
  const userRepo = { find: jest.fn().mockResolvedValue([
    { id: ADMIN_ID, name: 'Edison Roa', username: 'edison' },
    { id: TARGET_ID, name: 'Hugo Caja', username: 'cajero' },
  ]) };
  const paymentRepo = {
    find: jest.fn().mockResolvedValue([{
      id: PAYMENT_ID, amount: '319000.00', currency: 'PYG', clientName: 'Cliente Uno', clientCode: '345', paymentRef: '5318',
      sourceBank: 'FAMILIAR', isAtlasAccount: false, status: PaymentState.CONFIRMADO_MANUAL, createdBy: { name: 'Matias', username: 'matias' },
    }]),
    findOne: jest.fn(),
    manager: { getRepository: jest.fn((entity) => (entity === BankTransfer ? transferRepo : entity === User ? userRepo : null)) },
  };
  return { service: new PaymentsService(paymentRepo as any, auditRepo as any), paymentRepo, userRepo, transferRepo };
};

describe('Auditoria legible', () => {
  it('cada registro trae nombre de quien actuo, la consulta, la transferencia y el usuario afectado', async () => {
    const { service, paymentRepo, transferRepo, userRepo } = makeService([
      { id: 'a1', action: 'PAYMENT_CONFIRMED_MANUAL', userId: ADMIN_ID, paymentId: PAYMENT_ID },
      { id: 'a2', action: 'BANK_CLAIM_REVIEWED', userId: ADMIN_ID, paymentId: PAYMENT_ID, bankTransferId: TRANSFER_ID },
      { id: 'a3', action: 'USER_UPDATED', userId: ADMIN_ID, targetUserId: TARGET_ID },
      { id: 'a4', action: 'BANK_TRANSFER_REVERSED', userId: 'system', bankTransferId: TRANSFER_ID },
    ]);
    const { items } = await service.listAudit({} as any);

    expect(items[0]).toMatchObject({
      actorName: 'Edison Roa',
      payment: { clientCode: '345', clientName: 'Cliente Uno', paymentRef: '5318', amount: 319000, isAtlasAccount: false, collectorName: 'Matias' },
    });
    expect(items[1]).toMatchObject({ bankTransfer: { amount: 319000, bankDocNumber: '25895' } });
    expect(items[2]).toMatchObject({ targetUserName: 'Hugo Caja' });
    expect(items[3]).toMatchObject({ actorName: null, bankTransfer: { id: TRANSFER_ID } });
    // Una consulta por tipo, sin buscar el usuario "system".
    expect(paymentRepo.find).toHaveBeenCalledTimes(1);
    expect(transferRepo.find).toHaveBeenCalledTimes(1);
    expect(userRepo.find).toHaveBeenCalledTimes(1);
  });

  it('no expone remitente ni cuenta de la transferencia (el supervisor tambien lee la auditoria)', async () => {
    const { service, transferRepo } = makeService([{ id: 'a1', action: 'BANK_TRANSFER_CLAIMED', userId: ADMIN_ID, bankTransferId: TRANSFER_ID }]);
    await service.listAudit({} as any);
    const select = transferRepo.find.mock.calls[0][0].select;
    expect(select).not.toHaveProperty('senderName');
    expect(select).not.toHaveProperty('senderAccount');
    expect(select).not.toHaveProperty('senderDoc');
  });

  it('en la linea de vida de un pago ajeno el cobrador ve nombres, pero no datos de consultas ni metadatos', async () => {
    const { service, paymentRepo } = makeService([{ id: 'a1', action: 'PAYMENT_REJECTED', userId: ADMIN_ID, paymentId: PAYMENT_ID, metadata: '{"reason":"x"}' }]);
    paymentRepo.findOne.mockResolvedValue({ id: PAYMENT_ID, createdById: 'otro-cobrador' });
    const logs: any[] = await service.getAuditForPayment(PAYMENT_ID, { userId: 'col-1', role: UserRole.COBRADOR });
    expect(logs[0]).toMatchObject({ metadata: null, actorName: 'Edison Roa' });
    expect(logs[0].payment).toBeUndefined();
    expect(paymentRepo.find).not.toHaveBeenCalled();
  });
});
