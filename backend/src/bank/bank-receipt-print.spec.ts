import { ConflictException, ForbiddenException } from '@nestjs/common';
import { FindOperator } from 'typeorm';
import { Payment, PaymentState } from '../payments/entities/payment.entity';
import { AuditLog } from '../payments/entities/audit-log.entity';
import { PaymentsService } from '../payments/payments.service';
import { UserRole } from '../users/entities/user.entity';
import { BankTransfersService } from './bank-transfers.service';
import { BankTransferClaim, ClaimReferenceType, ClaimStatus } from './entities/bank-transfer-claim.entity';
import { BankTransfer, BankTransferSource, BankTransferStatus } from './entities/bank-transfer.entity';

const admin = { userId: 'admin-1', username: 'admin', name: 'Administrador', role: UserRole.ADMIN };
const collector = { userId: 'collector-1', username: 'taty', name: 'Taty', role: UserRole.COBRADOR };

const matchesWhere = (row: Partial<AuditLog>, where: Record<string, unknown>) =>
  Object.entries(where).every(([field, expected]) => {
    const actual = row[field];
    if (!(expected instanceof FindOperator)) return actual === expected;
    if (expected.type === 'in') return expected.value.includes(actual);
    if (expected.type === 'like') {
      const escaped = String(expected.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
      return new RegExp(`^${escaped}$`).test(String(actual ?? ''));
    }
    throw new Error(`Operador de prueba no soportado: ${expected.type}`);
  });

const fixture = (options: { paymentStatus?: PaymentState; printedAt?: Date | null; claimStatus?: ClaimStatus; reviewedBefore?: number; paymentCreatedById?: string } = {}) => {
  const transfer = {
    id: 'transfer-1', amount: 300, allocatedAmount: 300, currency: 'PYG', source: BankTransferSource.ATLAS,
    status: BankTransferStatus.TOMADA, senderName: 'REMITENTE', bankDocNumber: '25895', movementAt: new Date(),
  } as BankTransfer;
  const claim = {
    id: 'claim-1', bankTransferId: transfer.id, amount: 300, referenceType: ClaimReferenceType.CONSULTA,
    referenceValue: 'payment-1', paymentId: 'payment-1', receiptNumber: 'TR-000007', claimedAt: new Date(),
    claimedById: collector.userId, claimedByName: 'Taty', claimedByUsername: 'taty', claimedByRole: UserRole.COBRADOR,
    status: options.claimStatus ?? ClaimStatus.ACTIVA, printCount: 0,
  } as BankTransferClaim;
  const payment = {
    id: 'payment-1', createdById: options.paymentCreatedById ?? collector.userId, status: options.paymentStatus ?? PaymentState.CONFIRMADO,
    printedAt: options.printedAt ?? null, paymentRef: 'OP-55', clientName: 'Cliente Uno', clientCode: 'CLI-0042',
    createdBy: { name: 'Taty', username: 'taty' },
  } as unknown as Payment;
  const audits: Partial<AuditLog>[] = [];
  const auditQuery: any = { where: () => auditQuery, getCount: async () => options.reviewedBefore ?? 0 };
  const paymentRepo = {
    find: jest.fn().mockResolvedValue([payment]),
    findOne: jest.fn().mockResolvedValue(payment),
    save: jest.fn(async (row) => row),
  };
  const auditRepo = {
    create: jest.fn((row) => row),
    save: jest.fn(async (row) => { audits.push(row); return row; }),
    find: jest.fn(async ({ where }) => audits.filter((row) => matchesWhere(row, where))),
    findOne: jest.fn(async ({ where }) => audits.find((row) => matchesWhere(row, where)) ?? null),
    createQueryBuilder: () => auditQuery,
  };
  const repos = new Map<unknown, any>([
    [BankTransfer, { findOne: jest.fn().mockResolvedValue(transfer) }],
    [BankTransferClaim, {
      find: jest.fn().mockResolvedValue(claim.status === ClaimStatus.ACTIVA ? [claim] : []),
      findOne: jest.fn().mockResolvedValue(claim),
      save: jest.fn(async (row) => row),
    }],
    [Payment, paymentRepo],
    [AuditLog, auditRepo],
  ]);
  const manager = { getRepository: jest.fn((entity) => repos.get(entity)) };
  const dataSource = { manager, transaction: jest.fn(async (callback) => callback(manager)) };
  const gateway = { emitPaymentsChanged: jest.fn(), emitToRoom: jest.fn() };
  const service = new BankTransfersService(dataSource as any, gateway as any, {} as any);
  const payments = new PaymentsService({ ...paymentRepo, manager: dataSource } as any, auditRepo as any);
  const broadcast = jest.spyOn(service, 'broadcast').mockResolvedValue(undefined);
  return { service, payments, claim, payment, paymentRepo, auditRepo, audits, gateway, broadcast };
};

describe('Comprobante de conciliacion: impresion en dos pasos', () => {
  it('abrir el dialogo no cuenta como impreso, pero queda auditado y el papel lleva la copia que tendra', async () => {
    const { service, claim, payment, audits } = fixture();
    const receipt = await service.printPreview('transfer-1', collector, claim.id);
    expect(claim.printCount).toBe(0);
    expect(payment.printedAt).toBeNull();
    expect(receipt.printCount).toBe(1);
    expect(audits).toEqual([expect.objectContaining({ action: 'BANK_TRANSFER_RECEIPT_PRINT_OPENED' })]);
  });

  it('el comprobante lleva el codigo y el nombre del cliente que cargo el cobrador', async () => {
    const { service, claim } = fixture();
    const receipt = await service.printPreview('transfer-1', collector, claim.id);
    expect(receipt).toMatchObject({ clientCode: 'CLI-0042', clientName: 'Cliente Uno', paymentRef: 'OP-55', transferId: 'transfer-1', claimId: 'claim-1', paymentId: 'payment-1' });
  });

  it('solo quien tomo la transferencia o un admin abre el comprobante', async () => {
    const { service, claim } = fixture();
    await expect(service.printPreview('transfer-1', { ...collector, userId: 'otro' }, claim.id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('confirmar la impresion la cuenta y marca impresa la consulta conciliada: no pide otro ticket', async () => {
    const { service, claim, payment, audits, gateway, broadcast } = fixture();
    const opened = await service.printPreview('transfer-1', collector, claim.id);
    const receipt = await service.print('transfer-1', collector, claim.id, opened.printAuthorizationId);
    expect(claim.printCount).toBe(1);
    expect(receipt.printCount).toBe(1);
    expect(payment.printedAt).toBeInstanceOf(Date);
    expect(audits.map((a) => a.action)).toEqual(['BANK_TRANSFER_RECEIPT_PRINT_OPENED', 'BANK_TRANSFER_RECEIPT_PRINTED', 'PAYMENT_PRINTED']);
    expect(gateway.emitPaymentsChanged).toHaveBeenCalledWith(expect.objectContaining({ type: 'PAYMENT_PRINTED', paymentId: 'payment-1' }));
    expect(broadcast).toHaveBeenCalledWith(expect.anything(), 'bank-transfers:updated');
  });

  it('una reimpresion no vuelve a marcar la consulta ni una consulta sin aprobar queda impresa', async () => {
    const printedBefore = new Date('2026-10-12T20:00:00Z');
    const reprint = fixture({ printedAt: printedBefore });
    const reprinted = await reprint.service.printPreview('transfer-1', admin, reprint.claim.id, 'Se dañó el comprobante original');
    await reprint.service.print('transfer-1', admin, reprint.claim.id, reprinted.printAuthorizationId);
    expect(reprint.payment.printedAt).toBe(printedBefore);
    expect(reprint.gateway.emitPaymentsChanged).not.toHaveBeenCalled();

    const partial = fixture({ paymentStatus: PaymentState.PENDIENTE_VERIFICACION });
    const opened = await partial.service.printPreview('transfer-1', collector, partial.claim.id);
    await partial.service.print('transfer-1', collector, partial.claim.id, opened.printAuthorizationId);
    expect(partial.payment.printedAt).toBeNull();
  });

  it('si falla el aviso posterior al commit devuelve la impresion ya confirmada', async () => {
    const { service, claim, payment, broadcast } = fixture();
    const opened = await service.printPreview('transfer-1', collector, claim.id);
    broadcast.mockRejectedValueOnce(new Error('socket no disponible'));
    await expect(service.print('transfer-1', collector, claim.id, opened.printAuthorizationId)).resolves.toMatchObject({ printCount: 1 });
    expect(payment.printedAt).toBeInstanceOf(Date);
    expect(claim.printCount).toBe(1);
  });

  it('si falla el aviso de consulta impresa no invita a repetir una confirmacion persistida', async () => {
    const { service, claim, gateway } = fixture();
    const opened = await service.printPreview('transfer-1', collector, claim.id);
    gateway.emitPaymentsChanged.mockImplementationOnce(() => { throw new Error('socket no disponible'); });
    await expect(service.print('transfer-1', collector, claim.id, opened.printAuthorizationId)).resolves.toMatchObject({ printCount: 1 });
  });

  it('un cobrador no vuelve a abrir aunque no haya confirmado la primera apertura', async () => {
    const { service, claim, payment, audits } = fixture();
    await service.printPreview('transfer-1', collector, claim.id);
    await expect(service.printPreview('transfer-1', collector, claim.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(claim.printCount).toBe(0);
    expect(payment.printedAt).toBeNull();
    expect(audits.map((row) => row.action)).toEqual(['BANK_TRANSFER_RECEIPT_PRINT_OPENED']);
  });

  it('repetir la confirmación propia no cuenta ni audita otra copia', async () => {
    const { service, claim, audits } = fixture();
    const opened = await service.printPreview('transfer-1', collector, claim.id);
    await service.print('transfer-1', collector, claim.id, opened.printAuthorizationId);
    const lastPrintedAt = claim.lastPrintedAt;
    await service.print('transfer-1', collector, claim.id, opened.printAuthorizationId);
    expect(claim.printCount).toBe(1);
    expect(claim.lastPrintedAt).toBe(lastPrintedAt);
    expect(audits.filter((row) => row.action === 'BANK_TRANSFER_RECEIPT_PRINTED')).toHaveLength(1);
  });

  it('ADMIN no confirma una autorización emitida a otro usuario', async () => {
    const { service, claim, payment, audits } = fixture();
    const opened = await service.printPreview('transfer-1', collector, claim.id);
    await expect(service.print('transfer-1', admin, claim.id, opened.printAuthorizationId)).rejects.toBeInstanceOf(ForbiddenException);
    expect(claim.printCount).toBe(0);
    expect(payment.printedAt).toBeNull();
    expect(audits.filter((row) => row.action === 'BANK_TRANSFER_RECEIPT_PRINTED')).toHaveLength(0);
  });
});

describe('Cola de conciliaciones para revisar', () => {
  it('el servicio tambien rechaza marcar Revisada por un cajero', async () => {
    const { service, audits } = fixture();
    await expect(service.markReviewed('transfer-1', 'claim-1', { ...admin, role: UserRole.CAJERO })).rejects.toBeInstanceOf(ForbiddenException);
    expect(audits).toEqual([]);
  });
  it('el admin la marca revisada sin anular nada, y repetirlo no duplica el registro', async () => {
    const first = fixture();
    await expect(first.service.markReviewed('transfer-1', 'claim-1', admin)).resolves.toEqual({ claimId: 'claim-1', reviewed: true });
    expect(first.audits).toEqual([expect.objectContaining({ action: 'BANK_CLAIM_REVIEWED', bankTransferId: 'transfer-1', userId: 'admin-1' })]);
    expect(first.claim.status).toBe(ClaimStatus.ACTIVA);

    const again = fixture({ reviewedBefore: 1 });
    await again.service.markReviewed('transfer-1', 'claim-1', admin);
    expect(again.audits).toEqual([]);
  });

  it('una conciliacion anulada no se marca revisada', async () => {
    const { service } = fixture({ claimStatus: ClaimStatus.ANULADA });
    await expect(service.markReviewed('transfer-1', 'claim-1', admin)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('Ticket de consulta: impresion en dos pasos', () => {
  const makeService = (status: PaymentState, createdById = 'collector-1') => {
    const f = fixture({ paymentStatus: status, paymentCreatedById: createdById });
    return { service: f.payments, payment: f.payment, paymentRepo: f.paymentRepo, auditRepo: f.auditRepo };
  };

  it('abrir el dialogo no marca impreso; queda auditado', async () => {
    const { service, payment, paymentRepo, auditRepo } = makeService(PaymentState.CONFIRMADO);
    await service.openPrintDialog(payment.id, collector);
    expect(payment.printedAt).toBeNull();
    expect(paymentRepo.save).not.toHaveBeenCalled();
    expect(auditRepo.save).toHaveBeenCalledWith(expect.objectContaining({ action: 'PAYMENT_PRINT_OPENED' }));
  });

  it('un cobrador no abre tickets ajenos ni de consultas sin aprobar', async () => {
    await expect(makeService(PaymentState.CONFIRMADO, 'otro').service.openPrintDialog('payment-1', collector)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(makeService(PaymentState.PENDIENTE_VERIFICACION).service.openPrintDialog('payment-1', collector)).rejects.toBeInstanceOf(ConflictException);
  });
});
