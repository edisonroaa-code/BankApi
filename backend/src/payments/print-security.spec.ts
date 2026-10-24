import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { AuditLog } from './entities/audit-log.entity';
import { Payment, PaymentState } from './entities/payment.entity';
import { UserRole } from '../users/entities/user.entity';
import { BankTransfersService } from '../bank/bank-transfers.service';
import { BankTransfer, BankTransferSource, BankTransferStatus } from '../bank/entities/bank-transfer.entity';
import { BankTransferClaim, ClaimReferenceType, ClaimStatus } from '../bank/entities/bank-transfer-claim.entity';

const printedAt = new Date('2026-10-24T11:00:00Z');
const actor = (role: UserRole) => ({ userId: 'operator-1', username: 'prueba', name: 'Operador sintético', role });

const fixture = (options: { paymentPrinted?: boolean; claimPrintCount?: number } = {}) => {
  const payment = {
    id: 'payment-1', createdById: 'operator-1', status: PaymentState.CONFIRMADO,
    amount: 200000, allocatedAmount: 200000, isAtlasAccount: true,
    printedAt: options.paymentPrinted ? printedAt : null, verifiedAt: printedAt,
    clientCode: 'PRUEBA-1', clientName: 'Cliente sintético', createdBy: { name: 'Operador sintético' },
  } as unknown as Payment;
  const transfer = {
    id: 'transfer-1', amount: 200000, allocatedAmount: 200000, currency: 'PYG',
    source: BankTransferSource.ATLAS, status: BankTransferStatus.TOMADA,
    movementAt: new Date('2026-10-24T10:00:00Z'), bankDocNumber: 'PRUEBA-101',
  } as BankTransfer;
  const claim = {
    id: 'claim-1', bankTransferId: transfer.id, paymentId: payment.id,
    referenceType: ClaimReferenceType.CONSULTA, referenceValue: 'PRUEBA-101',
    amount: 200000, receiptNumber: 'TR-PRUEBA-1', claimedById: 'operator-1',
    claimedByRole: UserRole.COBRADOR, claimedAt: new Date('2026-10-24T10:10:00Z'),
    status: ClaimStatus.ACTIVA, printCount: options.claimPrintCount ?? 0,
  } as BankTransferClaim;
  const paymentRepo = { findOne: jest.fn().mockResolvedValue(payment), find: jest.fn().mockResolvedValue([payment]), save: jest.fn(async (row) => row) };
  const claimRepo = { findOne: jest.fn().mockResolvedValue(claim), find: jest.fn().mockResolvedValue([claim]), save: jest.fn(async (row) => row) };
  const auditQuery: any = {};
  for (const name of ['where', 'andWhere', 'orderBy', 'select', 'take']) auditQuery[name] = jest.fn().mockReturnValue(auditQuery);
  auditQuery.getMany = jest.fn().mockResolvedValue([]);
  auditQuery.getOne = jest.fn().mockResolvedValue(null);
  auditQuery.getCount = jest.fn().mockResolvedValue(0);
  const auditRepo = {
    create: jest.fn((row) => row), save: jest.fn(async (row) => row), findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]), createQueryBuilder: jest.fn().mockReturnValue(auditQuery),
  };
  const manager = {
    getRepository: jest.fn((entity) => {
      if (entity === Payment) return paymentRepo;
      if (entity === BankTransfer) return { findOne: jest.fn().mockResolvedValue(transfer) };
      if (entity === BankTransferClaim) return claimRepo;
      if (entity === AuditLog) return auditRepo;
      throw new Error('Repositorio inesperado en la prueba');
    }),
    query: jest.fn().mockResolvedValue([]),
  };
  const dataSource = { manager, transaction: jest.fn(async (callback) => callback(manager)) };
  const payments = new PaymentsService({ ...paymentRepo, manager: dataSource } as any, auditRepo as any);
  const bank = new BankTransfersService(dataSource as any, { emitPaymentsChanged: jest.fn(), emitToRoom: jest.fn() } as any, {} as any);
  jest.spyOn(bank, 'broadcast').mockResolvedValue(undefined);
  return { payments, bank, payment, claim, paymentRepo, claimRepo, auditRepo };
};

const expectForbiddenOrMissingAuthorization = async (operation: Promise<unknown>) => {
  await operation.then(
    () => { throw new Error('Una confirmación sin autorización debe rechazarse.'); },
    (error) => { expect(error instanceof ForbiddenException || error instanceof BadRequestException).toBe(true); },
  );
};

describe('Seguridad: ningún rol distinto de ADMIN reimprime tickets', () => {
  it.each([UserRole.COBRADOR, UserRole.SUPERVISOR])('%s no vuelve a abrir un ticket de consulta ya impreso aunque sea propio', async (role) => {
    const { payments, payment, paymentRepo, auditRepo } = fixture({ paymentPrinted: true });
    await expect(payments.openPrintDialog(payment.id, actor(role))).rejects.toBeInstanceOf(ForbiddenException);
    expect(payment.printedAt).toBe(printedAt);
    expect(paymentRepo.save).not.toHaveBeenCalled();
    expect(auditRepo.save).not.toHaveBeenCalled();
  });

  it.each([UserRole.COBRADOR, UserRole.SUPERVISOR])('%s no registra directamente otra impresión sin autorización', async (role) => {
    const { payments, payment, paymentRepo, auditRepo } = fixture({ paymentPrinted: true });
    await expectForbiddenOrMissingAuthorization(payments.markAsPrinted(payment.id, actor(role)));
    expect(payment.printedAt).toBe(printedAt);
    expect(paymentRepo.save).not.toHaveBeenCalled();
    expect(auditRepo.save).not.toHaveBeenCalled();
  });

  it.each([UserRole.COBRADOR, UserRole.CAJERO])('%s no vuelve a abrir un comprobante bancario ya impreso aunque sea dueño de la toma', async (role) => {
    const { bank, claim, payment, claimRepo, auditRepo } = fixture({ claimPrintCount: 1 });
    await expect(bank.printPreview('transfer-1', actor(role), claim.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(claim.printCount).toBe(1);
    expect(payment.printedAt).toBeNull();
    expect(claimRepo.save).not.toHaveBeenCalled();
    expect(auditRepo.save).not.toHaveBeenCalled();
  });

  it.each([UserRole.COBRADOR, UserRole.CAJERO])('%s no confirma directamente otra impresión bancaria sin autorización', async (role) => {
    const { bank, claim, claimRepo, auditRepo } = fixture({ claimPrintCount: 1 });
    await expectForbiddenOrMissingAuthorization(bank.print('transfer-1', actor(role), claim.id));
    expect(claim.printCount).toBe(1);
    expect(claimRepo.save).not.toHaveBeenCalled();
    expect(auditRepo.save).not.toHaveBeenCalled();
  });

  it.each([UserRole.COBRADOR, UserRole.CAJERO])('%s no elude la restricción con un comprobante bancario cuyo ticket de consulta ya está impreso', async (role) => {
    const { bank, claim, payment, claimRepo, auditRepo } = fixture({ paymentPrinted: true, claimPrintCount: 0 });
    await expect(bank.printPreview('transfer-1', actor(role), claim.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(payment.printedAt).toBe(printedAt);
    expect(claim.printCount).toBe(0);
    expect(claimRepo.save).not.toHaveBeenCalled();
    expect(auditRepo.save).not.toHaveBeenCalled();
  });

  it('ADMIN debe justificar la reapertura de un ticket de consulta', async () => {
    const { payments, payment, auditRepo } = fixture({ paymentPrinted: true });
    await expect(payments.openPrintDialog(payment.id, actor(UserRole.ADMIN))).rejects.toBeInstanceOf(BadRequestException);
    expect(auditRepo.save).not.toHaveBeenCalled();
  });

  it('ADMIN debe justificar la reapertura de un comprobante bancario', async () => {
    const { bank, claim, auditRepo } = fixture({ claimPrintCount: 1 });
    await expect(bank.printPreview('transfer-1', actor(UserRole.ADMIN), claim.id)).rejects.toBeInstanceOf(BadRequestException);
    expect(auditRepo.save).not.toHaveBeenCalled();
  });
});
