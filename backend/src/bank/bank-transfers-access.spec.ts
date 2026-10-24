import { ConflictException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '../users/entities/user.entity';
import { Payment, PaymentState } from '../payments/entities/payment.entity';
import { BankTransferClaim, ClaimReferenceType, ClaimStatus } from './entities/bank-transfer-claim.entity';
import { BankTransfer, BankTransferStatus } from './entities/bank-transfer.entity';
import { AuditLog } from '../payments/entities/audit-log.entity';
import { BankTransfersService } from './bank-transfers.service';

const actor = { userId: 'user-1', role: UserRole.COBRADOR, username: 'cobrador-1' };

describe('BankTransfersService access and idempotency', () => {
  it.each([
    [[{ account: '123', bank: 'UENO BANK', code: '7098' }], true],
    [[{ account: '123', bank: 'BANCO ITAU', code: '7098' }], false],
    [[{ account: '123', bank: 'UENO BANK', code: '7098' }, { account: '123', bank: 'UENO BANK', code: '8800' }], false],
  ])('uses an unambiguous history from the same sender bank (%s)', async (history, expected) => {
    const payment = { id: 'p-1', clientCode: '7098', clientName: 'Cliente de prueba', amount: 1000, allocatedAmount: 0,
      sourceBank: 'UENO BANK', isAtlasAccount: true, createdAt: new Date('2026-10-24T12:00:00Z') };
    const transfer = { id: 't-1', senderAccount: '123', senderBankName: 'UENO BANK SOCIEDAD ANONIMA',
      amount: 1000, allocatedAmount: 0, movementAt: new Date('2026-10-24T11:00:00Z'), rawPayload: {} };
    const qb: Record<string, jest.Mock> = {};
    qb.alias = 't' as any;
    for (const name of ['where', 'andWhere', 'orderBy', 'addOrderBy', 'clone', 'take']) qb[name] = jest.fn().mockReturnValue(qb);
    qb.getMany = jest.fn().mockResolvedValue([transfer]);
    const repo = (entity) => {
      if (entity === Payment) return { findOne: jest.fn().mockResolvedValue(payment) };
      if (entity === BankTransfer) return { createQueryBuilder: () => qb };
      return { find: jest.fn().mockResolvedValue([]) };
    };
    const dataSource = { getRepository: repo, manager: { getRepository: repo, query: jest.fn().mockResolvedValue(history) } };
    const service = new BankTransfersService(dataSource as any, {} as any, {} as any);
    const matches = await service.matchesForPayment('p-1', { ...actor, role: UserRole.ADMIN });
    expect(matches[0].match.evidence.includes('CUENTA_CONOCIDA' as any)).toBe(expected);
  });

  it('does not suggest Atlas movements for a BNF deposit', async () => {
    const dataSource = {
      getRepository: jest.fn((entity) => entity === Payment
        ? { findOne: jest.fn().mockResolvedValue({ id: 'payment-1', createdById: actor.userId, isAtlasAccount: false }) }
        : {}),
    };
    const service = new BankTransfersService(dataSource as any, {} as any, {} as any);
    await expect(service.matchesForPayment('payment-1', actor)).resolves.toEqual([]);
  });

  it('does not expose bank matches for a foreign collector payment', async () => {
    const dataSource = {
      getRepository: jest.fn((entity) => entity === Payment
        ? { findOne: jest.fn().mockResolvedValue({ id: 'payment-1', createdById: 'other-user' }) }
        : {}),
    };
    const service = new BankTransfersService(dataSource as any, {} as any, {} as any);

    await expect(service.matchesForPayment('payment-1', actor)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not replay a reconciliation key for another transfer, payment or user', async () => {
    const previous = {
      bankTransferId: 'transfer-1', paymentId: 'payment-1', claimedById: 'user-1',
      claimedByRole: UserRole.COBRADOR, referenceType: ClaimReferenceType.CONSULTA,
      status: ClaimStatus.ACTIVA, amount: 1000,
    };
    const claimRepo = { findOne: jest.fn().mockResolvedValue(previous) };
    const manager = { getRepository: jest.fn((entity) => entity === BankTransferClaim ? claimRepo : {}) };
    const dataSource = { transaction: jest.fn(async (callback) => callback(manager)) };
    const service = new BankTransfersService(dataSource as any, {} as any, {} as any);

    await expect(service.reconcile('transfer-2', 'payment-1', 'same-key', actor)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.reconcile('transfer-1', 'payment-2', 'same-key', actor)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.reconcile('transfer-1', 'payment-1', 'same-key', { ...actor, userId: 'other-user' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not replay a cashier key with changed reference or voided claim', async () => {
    const previous = {
      bankTransferId: 'transfer-1', paymentId: null, claimedById: 'cashier-1',
      claimedByRole: UserRole.CAJERO, referenceType: ClaimReferenceType.TICKET,
      referenceValue: 'TICKET1', status: ClaimStatus.ACTIVA, amount: 1000, note: null,
    };
    const claimRepo = { findOne: jest.fn().mockResolvedValue(previous) };
    const manager = { getRepository: jest.fn((entity) => entity === BankTransferClaim ? claimRepo : {}) };
    const dataSource = { transaction: jest.fn(async (callback) => callback(manager)) };
    const service = new BankTransfersService(dataSource as any, {} as any, {} as any);
    const cashier = { userId: 'cashier-1', role: UserRole.CAJERO };
    const request = { referenceType: ClaimReferenceType.TICKET as const, referenceValue: 'TICKET2', idempotencyKey: 'same-key' };

    await expect(service.claim('transfer-1', request, cashier)).rejects.toBeInstanceOf(ConflictException);
    previous.status = ClaimStatus.ANULADA;
    await expect(service.claim('transfer-1', { ...request, referenceValue: 'TICKET1' }, cashier)).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([UserRole.CAJERO, UserRole.ADMIN])('keeps a USD movement visible but unclaimable for %s', async (role) => {
    const transferRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'transfer-usd', amount: 1000, allocatedAmount: 0, currency: 'USD',
        status: BankTransferStatus.DISPONIBLE,
      }),
      save: jest.fn(),
    };
    const claimRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((value) => value),
      save: jest.fn().mockRejectedValue(new Error('Una toma USD nunca debe guardarse.')),
    };
    const auditRepo = { create: jest.fn((value) => value), save: jest.fn().mockResolvedValue(undefined) };
    const manager = {
      query: jest.fn().mockResolvedValue([{ n: 1 }]),
      getRepository: jest.fn((entity) => {
        if (entity === BankTransfer) return transferRepo;
        if (entity === BankTransferClaim) return claimRepo;
        if (entity === AuditLog) return auditRepo;
        return {};
      }),
    };
    const dataSource = { transaction: jest.fn(async (callback) => callback(manager)), manager };
    const service = new BankTransfersService(dataSource as any, {} as any, {} as any);

    await expect(service.claim('transfer-usd', {
      referenceType: ClaimReferenceType.TICKET,
      referenceValue: 'TICKET-1', idempotencyKey: `currency-${role}`,
    }, { userId: 'user-1', name: 'Operador', role })).rejects.toBeInstanceOf(ConflictException);
    expect(claimRepo.save).not.toHaveBeenCalled();
    expect(transferRepo.save).not.toHaveBeenCalled();
    expect(auditRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      action: 'BANK_TRANSFER_CLAIM_CONFLICT',
      metadata: expect.stringContaining('MONEDA_NO_SOPORTADA'),
    }));
  });

  it.each([false, null])('does not reconcile a payment classified as %s with the Atlas feed', async (isAtlasAccount) => {
    const transferRepo = { findOne: jest.fn().mockResolvedValue({
      id: 'transfer-1', amount: 1000, allocatedAmount: 0, status: BankTransferStatus.DISPONIBLE,
    }) };
    const paymentRepo = { findOne: jest.fn().mockResolvedValue({
      id: 'payment-1', createdById: actor.userId, amount: 1000, allocatedAmount: 0,
      status: PaymentState.PENDIENTE_VERIFICACION, isAtlasAccount,
    }) };
    const claimRepo = { findOne: jest.fn().mockResolvedValue(null), save: jest.fn() };
    const manager = { getRepository: jest.fn((entity) => {
      if (entity === BankTransfer) return transferRepo;
      if (entity === Payment) return paymentRepo;
      if (entity === BankTransferClaim) return claimRepo;
      return {};
    }) };
    const dataSource = { transaction: jest.fn(async (callback) => callback(manager)) };
    const service = new BankTransfersService(dataSource as any, {} as any, {} as any);

    await expect(service.reconcile('transfer-1', 'payment-1', 'new-key', actor)).rejects.toBeInstanceOf(ConflictException);
    expect(paymentRepo.findOne).toHaveBeenCalledWith({
      where: { id: 'payment-1' }, lock: { mode: 'pessimistic_write' },
    });
    expect(claimRepo.save).not.toHaveBeenCalled();
  });

  it('does not apply a USD bank movement to a PYG consultation with the same numeric amount', async () => {
    const transferRepo = { findOne: jest.fn().mockResolvedValue({
      id: 'transfer-usd', amount: 1000, allocatedAmount: 0, currency: 'USD',
      status: BankTransferStatus.DISPONIBLE,
    }), save: jest.fn() };
    const paymentRepo = { findOne: jest.fn().mockResolvedValue({
      id: 'payment-pyg', createdById: actor.userId, amount: 1000, allocatedAmount: 0,
      currency: 'PYG', status: PaymentState.PENDIENTE_VERIFICACION, isAtlasAccount: true,
    }), save: jest.fn() };
    const claimRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value) => value),
      save: jest.fn().mockRejectedValue(new Error('Una toma entre monedas diferentes nunca debe guardarse.')),
    };
    const manager = { query: jest.fn().mockResolvedValue([{ n: 1 }]), getRepository: jest.fn((entity) => {
      if (entity === BankTransfer) return transferRepo;
      if (entity === Payment) return paymentRepo;
      if (entity === BankTransferClaim) return claimRepo;
      return {};
    }) };
    const dataSource = { transaction: jest.fn(async (callback) => callback(manager)) };
    const service = new BankTransfersService(dataSource as any, {} as any, {} as any);

    await expect(service.reconcile('transfer-usd', 'payment-pyg', 'currency-key', { ...actor, name: 'Cobrador de prueba' }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(claimRepo.save).not.toHaveBeenCalled();
    expect(transferRepo.save).not.toHaveBeenCalled();
    expect(paymentRepo.save).not.toHaveBeenCalled();
  });

  it('only suggests Atlas-classified payments for reconciliation', async () => {
    const queryBuilder: Record<string, jest.Mock> = {};
    queryBuilder.alias = 'p' as any;
    for (const method of ['leftJoinAndSelect', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'clone', 'take']) {
      queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
    }
    queryBuilder.getMany = jest.fn().mockResolvedValue([]);
    const dataSource = { getRepository: jest.fn((entity) => entity === BankTransfer
      ? { findOne: jest.fn().mockResolvedValue({ id: 'transfer-1', movementAt: new Date(), senderAccount: null }) }
      : { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) }) };
    const service = new BankTransfersService(dataSource as any, {} as any, {} as any);

    await expect(service.candidatePayments('transfer-1', actor)).resolves.toEqual([]);
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('p."isAtlasAccount" = true');
  });
});
