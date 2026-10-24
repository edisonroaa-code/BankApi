import { BadRequestException, ConflictException, ForbiddenException, ValidationPipe } from '@nestjs/common';
import { Payment, PaymentState } from '../payments/entities/payment.entity';
import { AuditLog } from '../payments/entities/audit-log.entity';
import { UserRole } from '../users/entities/user.entity';
import { BankTransfersService } from './bank-transfers.service';
import { VoidBankTransferClaimDto } from './dto/bank-transfer.dto';
import { BankTransferClaim, ClaimReferenceType, ClaimStatus } from './entities/bank-transfer-claim.entity';
import { BankTransfer, BankTransferStatus } from './entities/bank-transfer.entity';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

const admin = { userId: 'admin-1', username: 'admin', name: 'Administrador', role: UserRole.ADMIN };

const fixture = (options: { paymentId?: string | null; transferAllocated?: number; paymentAllocated?: number; paymentAmount?: number; paymentStatus?: PaymentState; printedAt?: Date | null; cashPaidAt?: Date | null } = {}) => {
  const transfer = {
    id: 'transfer-1', amount: 1000, allocatedAmount: options.transferAllocated ?? 300,
    status: BankTransferStatus.PARCIAL,
  } as BankTransfer;
  const claim = {
    id: 'claim-1', bankTransferId: transfer.id, amount: 300,
    referenceType: options.paymentId ? ClaimReferenceType.CONSULTA : ClaimReferenceType.TICKET,
    referenceValue: 'TICKET-1', paymentId: options.paymentId ?? null,
    receiptNumber: 'TR-000001', claimedById: 'collector-1', claimedByRole: UserRole.COBRADOR,
    status: ClaimStatus.ACTIVA,
  } as BankTransferClaim;
  const payment = options.paymentId ? {
    id: options.paymentId, amount: options.paymentAmount ?? 300, allocatedAmount: options.paymentAllocated ?? 300,
    status: options.paymentStatus ?? PaymentState.CONFIRMADO, createdById: 'collector-1',
    printedAt: options.printedAt ?? null, cashPaidAt: options.cashPaidAt ?? null,
    verifiedById: 'collector-1', verifiedByUsername: 'collector', verifiedByName: 'Cobrador',
    verifiedAt: new Date(), decisionReason: 'Conciliado con transferencia bancaria TR-000001',
  } as Payment : null;
  const transferRepo = { findOne: jest.fn().mockResolvedValue(transfer), save: jest.fn(async (row) => row) };
  const claimRepo = { find: jest.fn().mockResolvedValue([claim]), save: jest.fn(async (row) => row) };
  const paymentRepo = { findOne: jest.fn().mockResolvedValue(payment), save: jest.fn(async (row) => row) };
  const auditRepo = { create: jest.fn((row) => row), save: jest.fn(async (row) => row) };
  const manager = { getRepository: jest.fn((entity) => {
    if (entity === BankTransfer) return transferRepo;
    if (entity === BankTransferClaim) return claimRepo;
    if (entity === Payment) return paymentRepo;
    if (entity === AuditLog) return auditRepo;
    throw new Error(`Unexpected repository ${entity.name}`);
  }) };
  const dataSource = { transaction: jest.fn(async (callback) => callback(manager)) };
  const gateway = { emitPaymentsChanged: jest.fn() };
  const service = new BankTransfersService(dataSource as any, gateway as any, {} as any);
  jest.spyOn(service, 'broadcast').mockResolvedValue(undefined);
  jest.spyOn(service, 'getOne').mockImplementation(async () =>
    service.toDto(transfer, (await claimRepo.find()).filter((row) => row.status === ClaimStatus.ACTIVA), true));
  return { service, dataSource, gateway, transfer, claim, payment, transferRepo, claimRepo, paymentRepo, auditRepo };
};

describe('BankTransfersService.void', () => {
  it('requiere el ID exacto de la toma para que un reintento no anule una toma nueva', async () => {
    const { service, dataSource } = fixture();
    await expect(service.void('transfer-1', 'Toma equivocada', admin, undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rechaza en el contrato HTTP una anulación sin claimId UUID', () => {
    const missing = validateSync(plainToInstance(VoidBankTransferClaimDto, { reason: 'Ticket incorrecto' }));
    const malformed = validateSync(plainToInstance(VoidBankTransferClaimDto, { reason: 'Ticket incorrecto', claimId: 'otro' }));
    expect(missing.some((error) => error.property === 'claimId')).toBe(true);
    expect(malformed.some((error) => error.property === 'claimId')).toBe(true);
  });

  it('el ValidationPipe devuelve 400 si claimId falta o no es UUID', async () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const body = { type: 'body' as const, metatype: VoidBankTransferClaimDto };
    for (const payload of [
      { reason: 'Ticket incorrecto' },
      { reason: 'Ticket incorrecto', claimId: 'otro' },
    ]) {
      try {
        await pipe.transform(payload, body);
        throw new Error('La solicitud inválida fue aceptada.');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getStatus()).toBe(400);
      }
    }
  });

  it.each([UserRole.CAJERO, UserRole.COBRADOR, UserRole.SUPERVISOR])(
    'rechaza a %s antes de abrir una transacción', async (role) => {
      const { service, dataSource } = fixture();
      await expect(service.void('transfer-1', 'Toma equivocada', { ...admin, role })).rejects.toBeInstanceOf(ForbiddenException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    },
  );

  it('exige una justificación no vacía de al menos 10 caracteres', async () => {
    const { service, dataSource } = fixture();
    await expect(service.void('transfer-1', '            ', admin)).rejects.toBeInstanceOf(BadRequestException);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('anula una toma de caja sin borrar su historial y devuelve el saldo dentro de la transacción', async () => {
    const { service, transfer, claim, transferRepo, claimRepo, auditRepo } = fixture();
    await service.void('transfer-1', 'Se tomó el ticket incorrecto', admin, claim.id);
    expect(claim.status).toBe(ClaimStatus.ANULADA);
    expect(claim.voidedById).toBe(admin.userId);
    expect(claim.voidReason).toBe('Se tomó el ticket incorrecto');
    expect(claim.voidedAt).toBeInstanceOf(Date);
    expect(transfer.allocatedAmount).toBe(0);
    expect(transfer.status).toBe(BankTransferStatus.DISPONIBLE);
    expect(claimRepo.save).toHaveBeenCalledWith(claim);
    expect(transferRepo.save).toHaveBeenCalledWith(transfer);
    expect(auditRepo.save).toHaveBeenCalledWith(expect.objectContaining({ action: 'BANK_TRANSFER_CLAIM_VOIDED' }));
  });

  it('con varias tomas anula solo la identificada y deja disponible únicamente su monto', async () => {
    const { service, transfer, claim, claimRepo } = fixture();
    const other = { ...claim, id: 'claim-2', amount: 700, receiptNumber: 'TR-000002' } as BankTransferClaim;
    transfer.allocatedAmount = 1000;
    transfer.status = BankTransferStatus.TOMADA;
    claimRepo.find.mockResolvedValue([claim, other]);
    const result = await service.void(transfer.id, 'Asignación equivocada de ticket', admin, claim.id);
    expect(claim.status).toBe(ClaimStatus.ANULADA);
    expect(other.status).toBe(ClaimStatus.ACTIVA);
    expect(transfer.allocatedAmount).toBe(700);
    expect(transfer.status).toBe(BankTransferStatus.PARCIAL);
    expect(result.claims).toEqual([expect.objectContaining({ id: other.id })]);
  });

  it('un reintento con ID viejo nunca anula una toma nueva sobre la misma transferencia', async () => {
    const { service, transfer, claim, claimRepo } = fixture();
    await service.void(transfer.id, 'Asignación equivocada de ticket', admin, claim.id);
    const newer = { ...claim, id: 'claim-new', amount: 300, status: ClaimStatus.ACTIVA } as BankTransferClaim;
    claimRepo.find.mockResolvedValue([newer]);
    transfer.allocatedAmount = 300;
    await expect(service.void(transfer.id, 'Asignación equivocada de ticket', admin, claim.id))
      .rejects.toBeInstanceOf(ConflictException);
    expect(newer.status).toBe(ClaimStatus.ACTIVA);
    expect(transfer.allocatedAmount).toBe(300);
    expect(claimRepo.save).toHaveBeenCalledTimes(1);
  });

  it('revierte también una consulta conciliada sin ticket ni caja y registra ambas auditorías', async () => {
    const { service, claim, payment, paymentRepo, auditRepo } = fixture({ paymentId: 'payment-1' });
    await service.void('transfer-1', 'Conciliada con otra consulta', admin, claim.id);
    expect(payment?.allocatedAmount).toBe(0);
    expect(payment?.status).toBe(PaymentState.PENDIENTE_VERIFICACION);
    expect(payment?.verifiedById).toBeNull();
    expect(paymentRepo.save).toHaveBeenCalledWith(payment);
    expect(auditRepo.save).toHaveBeenCalledWith(expect.objectContaining({ action: 'PAYMENT_BANK_RECONCILIATION_VOIDED' }));
    expect(auditRepo.save).toHaveBeenCalledWith(expect.objectContaining({ action: 'BANK_TRANSFER_CLAIM_VOIDED' }));
  });

  it('al quitar una toma parcial avisa actualización, sin afirmar que se anuló una decisión inexistente', async () => {
    const { service, claim, payment, gateway } = fixture({
      paymentId: 'payment-1', paymentAmount: 500, paymentStatus: PaymentState.PENDIENTE_VERIFICACION,
    });
    await service.void('transfer-1', 'Toma parcial de consulta equivocada', admin, claim.id);
    expect(payment?.status).toBe(PaymentState.PENDIENTE_VERIFICACION);
    expect(gateway.emitPaymentsChanged).toHaveBeenCalledWith(expect.objectContaining({
      type: 'PAYMENT_UPDATED', paymentId: 'payment-1',
    }));
  });

  it.each([
    ['ticket impreso', { printedAt: new Date() }],
    ['paso por caja', { cashPaidAt: new Date() }],
  ])('no revierte una consulta con %s', async (_label, fields) => {
    const { service, claim, claimRepo, transferRepo, paymentRepo } = fixture({ paymentId: 'payment-1', ...fields });
    await expect(service.void('transfer-1', 'Conciliada con otra consulta', admin, claim.id)).rejects.toBeInstanceOf(ConflictException);
    expect(claimRepo.save).not.toHaveBeenCalled();
    expect(transferRepo.save).not.toHaveBeenCalled();
    expect(paymentRepo.save).not.toHaveBeenCalled();
  });

  it('falla cerrado si la toma menciona una consulta que ya no existe', async () => {
    const { service, claim, claimRepo, transferRepo, paymentRepo } = fixture({ paymentId: 'payment-1' });
    paymentRepo.findOne.mockResolvedValue(null);
    await expect(service.void('transfer-1', 'Conciliada con otra consulta', admin, claim.id)).rejects.toBeInstanceOf(ConflictException);
    expect(claimRepo.save).not.toHaveBeenCalled();
    expect(transferRepo.save).not.toHaveBeenCalled();
  });

  it('falla cerrado si el saldo tomado de la transferencia no alcanza para revertir la toma', async () => {
    const { service, claim, claimRepo, transferRepo } = fixture({ transferAllocated: 100 });
    await expect(service.void('transfer-1', 'Conciliada con otra consulta', admin, claim.id)).rejects.toBeInstanceOf(ConflictException);
    expect(claimRepo.save).not.toHaveBeenCalled();
    expect(transferRepo.save).not.toHaveBeenCalled();
  });

  it('falla cerrado si el saldo del movimiento excede la suma de todas sus tomas activas', async () => {
    const { service, claim, claimRepo, transferRepo } = fixture({ transferAllocated: 500 });
    await expect(service.void('transfer-1', 'Asignación equivocada de ticket', admin, claim.id))
      .rejects.toBeInstanceOf(ConflictException);
    expect(claimRepo.save).not.toHaveBeenCalled();
    expect(transferRepo.save).not.toHaveBeenCalled();
  });

  it('falla cerrado si el saldo conciliado de la consulta no alcanza para revertir la toma', async () => {
    const { service, claim, claimRepo, transferRepo, paymentRepo } = fixture({ paymentId: 'payment-1', paymentAllocated: 100 });
    await expect(service.void('transfer-1', 'Conciliada con otra consulta', admin, claim.id)).rejects.toBeInstanceOf(ConflictException);
    expect(claimRepo.save).not.toHaveBeenCalled();
    expect(transferRepo.save).not.toHaveBeenCalled();
    expect(paymentRepo.save).not.toHaveBeenCalled();
  });

  it('falla cerrado si el saldo conciliado excede la suma de todas las tomas activas de la consulta', async () => {
    const { service, claim, claimRepo, transferRepo, paymentRepo } = fixture({
      paymentId: 'payment-1', paymentAmount: 500, paymentAllocated: 500,
    });
    await expect(service.void('transfer-1', 'Consulta asociada al pago equivocado', admin, claim.id))
      .rejects.toBeInstanceOf(ConflictException);
    expect(claimRepo.save).not.toHaveBeenCalled();
    expect(transferRepo.save).not.toHaveBeenCalled();
    expect(paymentRepo.save).not.toHaveBeenCalled();
  });

  it('admite pago partido entre dos movimientos cuando el saldo coincide con ambas tomas activas', async () => {
    const { service, claim, claimRepo, payment, paymentRepo } = fixture({
      paymentId: 'payment-1', paymentAmount: 500, paymentAllocated: 500,
    });
    const other = { ...claim, id: 'claim-on-other-transfer', bankTransferId: 'transfer-2', amount: 200 } as BankTransferClaim;
    claimRepo.find.mockImplementation(async (options: any) => options.where?.paymentId
      ? [claim, other] : [claim]);
    await service.void('transfer-1', 'Consulta asociada al pago equivocado', admin, claim.id);
    expect(payment?.allocatedAmount).toBe(200);
    expect(paymentRepo.save).toHaveBeenCalledWith(payment);
    expect(claim.status).toBe(ClaimStatus.ANULADA);
    expect(other.status).toBe(ClaimStatus.ACTIVA);
  });

  it('no convierte una anulación confirmada en error si falla el aviso o la lectura posterior al commit', async () => {
    const { service, claim, transfer } = fixture();
    jest.spyOn(service, 'broadcast').mockRejectedValue(new Error('socket unavailable'));
    jest.spyOn(service, 'getOne').mockRejectedValue(new Error('read unavailable'));
    await expect(service.void(transfer.id, 'Toma equivocada de ticket', admin, claim.id))
      .resolves.toMatchObject({ id: transfer.id, availableAmount: 1000, claims: [] });
    expect(claim.status).toBe(ClaimStatus.ANULADA);
  });
});
