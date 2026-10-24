import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { PaymentsService } from './payments.service';
import { Payment, PaymentState } from './entities/payment.entity';
import { AuditLog } from './entities/audit-log.entity';
import { BankTransferClaim } from '../bank/entities/bank-transfer-claim.entity';
import { UserRole } from '../users/entities/user.entity';

const collector = { userId: 'collector-1', username: 'c1', role: UserRole.COBRADOR };
const supervisor = { userId: 'supervisor-1', username: 's1', role: UserRole.SUPERVISOR };

const setup = (lockedState: PaymentState = PaymentState.PENDIENTE_VERIFICACION) => {
  const stale = {
    id: 'payment-1', createdById: collector.userId, status: PaymentState.PENDIENTE_VERIFICACION,
    amount: 1000, paymentRef: 'OLD-1', allocatedAmount: 0, isAtlasAccount: null,
  } as Payment;
  const locked = { ...stale, status: lockedState } as Payment;
  const duplicate = { id: 'payment-2', paymentRef: 'NEW-2' } as Payment;
  const txPaymentRepo = {
    findOne: jest.fn(async (options: any) => options.where.id ? locked : duplicate),
    save: jest.fn(async (payment: Payment) => payment),
  };
  const txAuditRepo = {
    create: jest.fn((entry) => entry),
    save: jest.fn(async (entry) => entry),
  };
  const txClaimRepo = { findOne: jest.fn().mockResolvedValue(null) };
  const manager = {
    getRepository: (entity: unknown) => {
      if (entity === Payment) return txPaymentRepo;
      if (entity === AuditLog) return txAuditRepo;
      if (entity === BankTransferClaim) return txClaimRepo;
      throw new Error('Unexpected repository');
    },
  };
  const paymentRepo = {
    findOne: jest.fn().mockResolvedValue(stale),
    save: jest.fn(async (payment: Payment) => payment),
    manager: { transaction: jest.fn((callback: (manager: unknown) => unknown) => callback(manager)) },
  };
  const auditRepo = { create: jest.fn((entry) => entry), save: jest.fn(async (entry) => entry) };
  const service = new PaymentsService(paymentRepo as any, auditRepo as any);
  return { service, stale, locked, txPaymentRepo, txAuditRepo, txClaimRepo, paymentRepo, auditRepo };
};

describe('Edición de una consulta pendiente', () => {
  it('lee con FOR UPDATE y cambia/audita en una única transacción', async () => {
    const { service, txPaymentRepo, txAuditRepo, paymentRepo, auditRepo } = setup();
    const updated = await service.updatePayment('payment-1', { amount: 1200 }, collector);
    expect(paymentRepo.manager.transaction).toHaveBeenCalledTimes(1);
    expect(txPaymentRepo.findOne).toHaveBeenCalledWith({ where: { id: 'payment-1' }, lock: { mode: 'pessimistic_write' } });
    expect(txPaymentRepo.save).toHaveBeenCalledWith(expect.objectContaining({ amount: 1200, status: PaymentState.PENDIENTE_VERIFICACION }));
    expect(txAuditRepo.save).toHaveBeenCalledWith(expect.objectContaining({ action: 'PAYMENT_UPDATED', paymentId: 'payment-1' }));
    expect(paymentRepo.save).not.toHaveBeenCalled();
    expect(auditRepo.save).not.toHaveBeenCalled();
    expect(updated.amount).toBe(1200);
  });

  it('no pisa una decisión concurrente que quedó confirmada antes de obtener el bloqueo', async () => {
    const { service, txPaymentRepo, paymentRepo } = setup(PaymentState.CONFIRMADO);
    await expect(service.updatePayment('payment-1', { amount: 1200 }, collector)).rejects.toBeInstanceOf(BadRequestException);
    expect(txPaymentRepo.save).not.toHaveBeenCalled();
    expect(paymentRepo.save).not.toHaveBeenCalled();
  });

  it('conserva el alcance del cobrador y permite al supervisor editar un pago pendiente ajeno', async () => {
    const { service, locked } = setup();
    locked.createdById = 'otro';
    await expect(service.updatePayment('payment-1', { amount: 1200 }, collector)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.updatePayment('payment-1', { amount: 1200 }, supervisor)).resolves.toMatchObject({ amount: 1200 });
  });

  it('traduce una referencia duplicada concurrente del índice único a conflicto', async () => {
    const { service, txPaymentRepo, txAuditRepo, locked } = setup();
    txPaymentRepo.findOne.mockResolvedValueOnce(locked).mockResolvedValueOnce(null as any);
    txPaymentRepo.save.mockRejectedValueOnce(new QueryFailedError('UPDATE payments', [], {
      code: '23505', constraint: 'uq_payments_payment_ref_active',
    } as any));
    await expect(service.updatePayment('payment-1', { paymentRef: 'NEW-2' }, collector))
      .rejects.toBeInstanceOf(ConflictException);
    expect(txAuditRepo.save).not.toHaveBeenCalled();
  });

  it('explica el conflicto si el monto editado cae bajo lo ya conciliado', async () => {
    const { service, txPaymentRepo, txAuditRepo } = setup();
    txPaymentRepo.save.mockRejectedValueOnce(new QueryFailedError('UPDATE payments', [], {
      code: '23514', constraint: 'ck_payments_allocated',
    } as any));
    await expect(service.updatePayment('payment-1', { amount: 50 }, collector))
      .rejects.toThrow('monto');
    expect(txAuditRepo.save).not.toHaveBeenCalled();
  });

  it('permite clasificar una consulta histórica sin alterar los montos conciliados', async () => {
    const { service, txPaymentRepo } = setup();
    await service.updatePayment('payment-1', { isAtlasAccount: false }, collector);
    expect(txPaymentRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      isAtlasAccount: false, allocatedAmount: 0, status: PaymentState.PENDIENTE_VERIFICACION,
    }));
  });

  it('permite al supervisor clasificar una consulta EN_REVISION y audita el estado real', async () => {
    const { service, txPaymentRepo, txAuditRepo } = setup(PaymentState.EN_REVISION);
    await service.updatePayment('payment-1', { isAtlasAccount: true }, supervisor);
    expect(txPaymentRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      isAtlasAccount: true, status: PaymentState.EN_REVISION,
    }));
    expect(txAuditRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      action: 'PAYMENT_UPDATED', beforeState: PaymentState.EN_REVISION, afterState: PaymentState.EN_REVISION,
    }));
  });

  it('no permite al cobrador editar EN_REVISION ni al supervisor cambiar otros campos', async () => {
    const { service, txPaymentRepo } = setup(PaymentState.EN_REVISION);
    await expect(service.updatePayment('payment-1', { isAtlasAccount: true }, collector)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.updatePayment('payment-1', { isAtlasAccount: true, amount: 1200 }, supervisor)).rejects.toBeInstanceOf(BadRequestException);
    expect(txPaymentRepo.save).not.toHaveBeenCalled();
  });

  it('no permite clasificar una consulta en revisión tomada por otro supervisor', async () => {
    const { service, locked, txPaymentRepo } = setup(PaymentState.EN_REVISION);
    locked.reviewClaimedById = 'supervisor-2';
    locked.reviewClaimedByName = 'Otro supervisor';
    locked.reviewClaimExpiresAt = new Date(Date.now() + 60_000);
    await expect(service.updatePayment('payment-1', { isAtlasAccount: true }, supervisor)).rejects.toThrow('Otro supervisor');
    expect(txPaymentRepo.save).not.toHaveBeenCalled();
  });

  it('no permite reclasificar una consulta ya conciliada parcial ni con toma bancaria activa', async () => {
    const { service, locked, txClaimRepo, txPaymentRepo } = setup();
    locked.allocatedAmount = 200;
    await expect(service.updatePayment('payment-1', { isAtlasAccount: false }, supervisor)).rejects.toBeInstanceOf(ConflictException);
    locked.allocatedAmount = 0;
    txClaimRepo.findOne.mockResolvedValue({ id: 'claim-1' });
    await expect(service.updatePayment('payment-1', { isAtlasAccount: false }, supervisor)).rejects.toBeInstanceOf(ConflictException);
    expect(txPaymentRepo.save).not.toHaveBeenCalled();
  });

  it('congela monto, referencia y evidencia luego de una toma parcial', async () => {
    for (const data of [{ amount: 400 }, { paymentRef: 'NEW-2' }, { clientCode: 'CLIENTE-OTRO' }]) {
      const { service, locked, txPaymentRepo, txAuditRepo } = setup();
      locked.allocatedAmount = 400;
      await expect(service.updatePayment('payment-1', data, collector)).rejects.toBeInstanceOf(ConflictException);
      expect(txPaymentRepo.save).not.toHaveBeenCalled();
      expect(txAuditRepo.save).not.toHaveBeenCalled();
    }
  });

  it('congela correcciones con una toma bancaria activa aunque el acumulado esté desfasado', async () => {
    const { service, txClaimRepo, txPaymentRepo } = setup();
    txClaimRepo.findOne.mockResolvedValue({ id: 'claim-1' });
    await expect(service.updatePayment('payment-1', { amount: 1200 }, collector)).rejects.toBeInstanceOf(ConflictException);
    expect(txPaymentRepo.save).not.toHaveBeenCalled();
  });
});
