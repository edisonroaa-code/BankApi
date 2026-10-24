import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { FindOperator } from 'typeorm';
import { PaymentsService } from './payments.service';
import { Payment, PaymentState } from './entities/payment.entity';
import { AuditLog } from './entities/audit-log.entity';
import { UserRole } from '../users/entities/user.entity';

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

describe('Registro de impresión de consultas', () => {
  const actor = { userId: 'supervisor-1', username: 'supervisor', role: UserRole.SUPERVISOR };

  const makeService = (status: PaymentState) => {
    const payment = { id: 'payment-1', createdById: 'collector-1', status, printedAt: null } as Payment;
    const lockedPaymentRepo = {
      findOne: jest.fn().mockResolvedValue(payment),
      save: jest.fn(async (value: Payment) => value),
    };
    const audits: Partial<AuditLog>[] = [];
    const auditRepo = {
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => { audits.push(value); return value; }),
      find: jest.fn(async ({ where }) => audits.filter((row) => matchesWhere(row, where))),
      findOne: jest.fn(async ({ where }) => audits.find((row) => matchesWhere(row, where)) ?? null),
    };
    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === Payment) return lockedPaymentRepo;
        if (entity === AuditLog) return auditRepo;
        throw new Error('Repositorio inesperado');
      }),
    };
    const paymentRepo = {
      findOne: jest.fn().mockResolvedValue(payment),
      save: jest.fn(),
      manager: { transaction: jest.fn((callback: (tx: typeof manager) => Promise<Payment>) => callback(manager)) },
    };
    return { service: new PaymentsService(paymentRepo as any, auditRepo as any), payment, paymentRepo, lockedPaymentRepo, auditRepo, audits };
  };

  it.each([
    PaymentState.PENDIENTE_VERIFICACION,
    PaymentState.EN_REVISION,
    PaymentState.RECHAZADO,
  ])('rechaza impresión en estado %s sin persistir ni auditar', async (status) => {
    const { service, payment, paymentRepo, lockedPaymentRepo, auditRepo } = makeService(status);

    await expect(service.markAsPrinted(payment.id, actor)).rejects.toBeInstanceOf(ConflictException);

    expect(payment.printedAt).toBeNull();
    expect(paymentRepo.save).not.toHaveBeenCalled();
    expect(lockedPaymentRepo.save).not.toHaveBeenCalled();
    expect(auditRepo.save).not.toHaveBeenCalled();
  });

  it.each([PaymentState.CONFIRMADO, PaymentState.CONFIRMADO_MANUAL])(
    'permite registrar impresión en estado %s', async (status) => {
      const { service, payment, paymentRepo, lockedPaymentRepo, auditRepo } = makeService(status);

      const opened = await service.openPrintDialog(payment.id, actor);
      const result = await service.markAsPrinted(payment.id, actor, opened.printAuthorizationId);

      expect(result.printedAt).toBeInstanceOf(Date);
      expect(paymentRepo.save).not.toHaveBeenCalled();
      expect(lockedPaymentRepo.save).toHaveBeenCalledTimes(1);
      expect(auditRepo.save).toHaveBeenCalledWith(expect.objectContaining({ action: 'PAYMENT_PRINTED' }));
    },
  );

  it('abrir y cancelar no habilita otra emisión para un supervisor', async () => {
    const { service, payment, audits, lockedPaymentRepo } = makeService(PaymentState.CONFIRMADO);
    await service.openPrintDialog(payment.id, actor);
    await expect(service.openPrintDialog(payment.id, actor)).rejects.toBeInstanceOf(ForbiddenException);
    expect(payment.printedAt).toBeNull();
    expect(lockedPaymentRepo.save).not.toHaveBeenCalled();
    expect(audits.map((row) => row.action)).toEqual(['PAYMENT_PRINT_OPENED']);
  });

  it('repetir la confirmación con la misma autorización no modifica fecha ni duplica auditoría', async () => {
    const { service, payment, audits, lockedPaymentRepo } = makeService(PaymentState.CONFIRMADO);
    const opened = await service.openPrintDialog(payment.id, actor);
    const first = await service.markAsPrinted(payment.id, actor, opened.printAuthorizationId);
    const printedAt = first.printedAt;
    await service.markAsPrinted(payment.id, actor, opened.printAuthorizationId);
    expect(payment.printedAt).toBe(printedAt);
    expect(lockedPaymentRepo.save).toHaveBeenCalledTimes(1);
    expect(audits.filter((row) => row.action === 'PAYMENT_PRINTED')).toHaveLength(1);
  });

  it('un supervisor no confirma la autorización de otro usuario', async () => {
    const { service, payment, audits, lockedPaymentRepo } = makeService(PaymentState.CONFIRMADO);
    const opened = await service.openPrintDialog(payment.id, actor);
    await expect(service.markAsPrinted(payment.id, { ...actor, userId: 'other-supervisor' }, opened.printAuthorizationId)).rejects.toBeInstanceOf(ForbiddenException);
    expect(payment.printedAt).toBeNull();
    expect(lockedPaymentRepo.save).not.toHaveBeenCalled();
    expect(audits.filter((row) => row.action === 'PAYMENT_PRINTED')).toHaveLength(0);
  });

  it('solo ADMIN puede reabrir con motivo, y la nueva copia conserva la fecha de primera impresión', async () => {
    const { service, payment, audits } = makeService(PaymentState.CONFIRMADO);
    const initial = await service.openPrintDialog(payment.id, actor);
    await service.markAsPrinted(payment.id, actor, initial.printAuthorizationId);
    const printedAt = payment.printedAt;
    const admin = { userId: 'admin-1', username: 'admin', role: UserRole.ADMIN };
    await expect(service.openPrintDialog(payment.id, admin)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.openPrintDialog(payment.id, admin, 'papel')).rejects.toBeInstanceOf(BadRequestException);
    const reprint = await service.openPrintDialog(payment.id, admin, 'Papel dañado en la primera impresión');
    expect(reprint.printCopyNumber).toBe(2);
    await service.markAsPrinted(payment.id, admin, reprint.printAuthorizationId);
    expect(payment.printedAt).toBe(printedAt);
    expect(audits.filter((row) => row.action === 'PAYMENT_PRINTED')).toHaveLength(2);
    expect(JSON.parse(audits[2].metadata!)).toMatchObject({ reprintReason: 'Papel dañado en la primera impresión', copyNumber: 2 });
  });

  it('no registra una impresión si una anulación cambió el estado antes de bloquear la fila', async () => {
    const stalePayment = { id: 'payment-1', createdById: 'collector-1', status: PaymentState.CONFIRMADO, printedAt: null } as Payment;
    const currentPayment = { ...stalePayment, status: PaymentState.PENDIENTE_VERIFICACION } as Payment;
    const lockedPaymentRepo = {
      findOne: jest.fn().mockResolvedValue(currentPayment),
      save: jest.fn(),
    };
    const auditRepo = { create: jest.fn((value) => value), save: jest.fn(), findOne: jest.fn() };
    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === Payment) return lockedPaymentRepo;
        if (entity === AuditLog) return auditRepo;
        throw new Error('Repositorio inesperado');
      }),
    };
    const paymentRepo = {
      findOne: jest.fn().mockResolvedValue(stalePayment),
      save: jest.fn(),
      manager: { transaction: jest.fn((callback: (tx: typeof manager) => Promise<Payment>) => callback(manager)) },
    };
    const service = new PaymentsService(paymentRepo as any, auditRepo as any);

    await expect(service.markAsPrinted(stalePayment.id, actor)).rejects.toBeInstanceOf(ConflictException);

    expect(lockedPaymentRepo.findOne).toHaveBeenCalledWith({
      where: { id: stalePayment.id },
      lock: { mode: 'pessimistic_write' },
    });
    expect(stalePayment.printedAt).toBeNull();
    expect(currentPayment.printedAt).toBeNull();
    expect(lockedPaymentRepo.save).not.toHaveBeenCalled();
    expect(paymentRepo.save).not.toHaveBeenCalled();
    expect(auditRepo.save).not.toHaveBeenCalled();
  });
});
