import { ConflictException, ForbiddenException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { Payment, PaymentState } from './entities/payment.entity';
import { AuditLog } from './entities/audit-log.entity';
import { Movement } from '../movements/entities/movement.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { BankTransferClaim } from '../bank/entities/bank-transfer-claim.entity';
import { BankTransfer, BankTransferStatus } from '../bank/entities/bank-transfer.entity';

const supervisor = { userId: 'sup-1', username: 'sup', name: 'Supervisor', role: UserRole.SUPERVISOR };
const collector = { userId: 'col-1', username: 'taty', name: 'Taty', role: UserRole.COBRADOR };

const makeService = (
  stored: Partial<Payment>,
  movement?: Partial<Movement>,
  bankClaim?: Partial<BankTransferClaim>,
  bankTransfers: Partial<BankTransfer>[] = [],
  claimedAmountMatch?: Partial<BankTransferClaim>,
) => {
  const payment = {
    id: 'p1', createdById: 'col-1', amount: 1000, allocatedAmount: 0,
    isAtlasAccount: false, createdAt: new Date('2026-09-24T12:00:00Z'), ...stored,
  } as Payment;
  const txPaymentRepo = {
    findOne: jest.fn().mockResolvedValue(payment),
    save: jest.fn(async (p: Payment) => p),
  };
  const txMovementRepo = {
    findOne: jest.fn().mockResolvedValue(movement ?? null),
    save: jest.fn(async (m: Movement) => m),
  };
  const txAuditRepo = { create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
  const manager = {
    getRepository: (entity: unknown) => {
      if (entity === Payment) return txPaymentRepo;
      if (entity === Movement) return txMovementRepo;
      if (entity === AuditLog) return txAuditRepo;
      if (entity === User) return { findOneBy: jest.fn().mockResolvedValue(null) };
      if (entity === BankTransferClaim) {
        const qb: Record<string, jest.Mock> = {};
        qb.select = jest.fn().mockReturnValue(qb);
        qb.innerJoin = jest.fn().mockReturnValue(qb);
        qb.where = jest.fn().mockReturnValue(qb);
        qb.andWhere = jest.fn().mockReturnValue(qb);
        qb.getOne = jest.fn().mockResolvedValue(claimedAmountMatch ?? null);
        return { findOne: jest.fn().mockResolvedValue(bankClaim ?? null), createQueryBuilder: jest.fn().mockReturnValue(qb) };
      }
      if (entity === BankTransfer) {
        const qb: Record<string, jest.Mock> = {};
        qb.select = jest.fn().mockReturnValue(qb);
        qb.where = jest.fn().mockReturnValue(qb);
        qb.orderBy = jest.fn().mockReturnValue(qb);
        qb.take = jest.fn().mockReturnValue(qb);
        qb.getMany = jest.fn().mockResolvedValue(bankTransfers);
        return { createQueryBuilder: jest.fn().mockReturnValue(qb) };
      }
      throw new Error('repositorio inesperado');
    },
  };
  const paymentRepo = {
    findOne: jest.fn().mockResolvedValue(payment),
    manager: { transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)) },
  };
  const auditRepo = { find: jest.fn().mockResolvedValue([]), create: jest.fn((x) => x), save: jest.fn() };
  const service = new PaymentsService(paymentRepo as any, auditRepo as any);
  return { service, payment, txPaymentRepo, txMovementRepo, txAuditRepo, auditRepo, paymentRepo };
};

describe('Decisiones sobre pagos', () => {
  it('bloquea la fila antes de decidir', async () => {
    const { service, txPaymentRepo } = makeService({ status: PaymentState.PENDIENTE_VERIFICACION });
    await service.confirmManual('p1', 'Ingreso verificado', supervisor);
    expect(txPaymentRepo.findOne).toHaveBeenCalledWith({ where: { id: 'p1' }, lock: { mode: 'pessimistic_write' } });
  });

  it('confirma un pago pendiente y audita dentro de la transaccion', async () => {
    const { service, txPaymentRepo, txAuditRepo } = makeService({ status: PaymentState.EN_REVISION });
    await service.confirmManual('p1', 'Ingreso verificado', supervisor);
    expect(txPaymentRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: PaymentState.CONFIRMADO_MANUAL }));
    expect(txAuditRepo.save).toHaveBeenCalledWith(expect.objectContaining({ action: 'PAYMENT_CONFIRMED_MANUAL' }));
  });

  it('impide aprobar manualmente una consulta parcialmente cubierta por el banco', async () => {
    const { service, txPaymentRepo } = makeService({
      status: PaymentState.EN_REVISION,
      allocatedAmount: 400,
    });
    await expect(service.confirmManual('p1', 'Ingreso verificado', supervisor)).rejects.toBeInstanceOf(ConflictException);
    expect(txPaymentRepo.save).not.toHaveBeenCalled();
  });

  it('impide aprobar manualmente una consulta con toma bancaria activa aunque el acumulado esté desfasado', async () => {
    const { service, txPaymentRepo } = makeService(
      { status: PaymentState.EN_REVISION, allocatedAmount: 0 },
      undefined,
      { receiptNumber: 'TR-000042' },
    );
    await expect(service.confirmManual('p1', 'Ingreso verificado', supervisor)).rejects.toThrow('TR-000042');
    expect(txPaymentRepo.save).not.toHaveBeenCalled();
  });

  it('no confunde una consulta BNF con una transferencia Atlas tomada de la misma referencia', async () => {
    const transfer = {
      id: 't1', amount: 1000, allocatedAmount: 1000, bankDocNumber: 'OPER-987654',
      movementAt: new Date('2026-09-24T10:00:00Z'), status: BankTransferStatus.TOMADA,
    } as BankTransfer;
    const { service, txPaymentRepo } = makeService(
      { status: PaymentState.EN_REVISION, paymentRef: 'OPER-987654' },
      undefined, undefined, [transfer],
    );
    await service.confirmManual('p1', undefined, supervisor);
    expect(txPaymentRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: PaymentState.CONFIRMADO_MANUAL }));
  });

  it('una transferencia Atlas disponible no bloquea una consulta clasificada BNF', async () => {
    const transfer = {
      id: 't1', amount: 1000, allocatedAmount: 0, bankDocNumber: 'OPER-987654',
      movementAt: new Date('2026-09-24T10:00:00Z'), status: BankTransferStatus.DISPONIBLE,
    } as BankTransfer;
    const { service, txPaymentRepo } = makeService(
      { status: PaymentState.EN_REVISION, paymentRef: 'OPER-987654' },
      undefined, undefined, [transfer],
    );
    await service.confirmManual('p1', undefined, supervisor);
    expect(txPaymentRepo.save).toHaveBeenCalled();
  });

  it('el codigo del mismo cliente en Atlas no demuestra que sea el deposito BNF', async () => {
    const transfer = {
      id: 't1', amount: 2200, allocatedAmount: 0, bankDocNumber: 'OTRO-555555',
      senderNote: 'Pago cliente 445566', movementAt: new Date('2026-09-24T10:00:00Z'),
      status: BankTransferStatus.DISPONIBLE,
    } as BankTransfer;
    const { service, txPaymentRepo } = makeService(
      { status: PaymentState.EN_REVISION, clientCode: '445566' },
      undefined, undefined, [transfer],
    );
    await service.confirmManual('p1', undefined, supervisor);
    expect(txPaymentRepo.save).toHaveBeenCalled();
  });

  it('permite confirmar manualmente cuando la unica coincidencia es el monto', async () => {
    const transfer = {
      id: 't1', amount: 1000, allocatedAmount: 0, bankDocNumber: 'OTRA-123456',
      movementAt: new Date('2026-09-24T10:00:00Z'), status: BankTransferStatus.DISPONIBLE,
    } as BankTransfer;
    const { service, txPaymentRepo } = makeService(
      { status: PaymentState.EN_REVISION, paymentRef: 'MI-987654' },
      undefined, undefined, [transfer],
    );
    await service.confirmManual('p1', 'Ingreso verificado', supervisor);
    expect(txPaymentRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: PaymentState.CONFIRMADO_MANUAL }));
  });

  it('no exige motivo si solo coincide el monto de una toma Atlas ajena al deposito BNF', async () => {
    const { service, txPaymentRepo } = makeService(
      { status: PaymentState.EN_REVISION, paymentRef: 'COMPROBANTE-1' },
      undefined, undefined, [], { id: 'claim-1' },
    );
    await service.confirmManual('p1', '  ', supervisor);
    expect(txPaymentRepo.save).toHaveBeenCalled();
  });

  it('permite decisión manual motivada si solo coincide el monto de una toma ajena', async () => {
    const { service, txPaymentRepo, txAuditRepo } = makeService(
      { status: PaymentState.EN_REVISION, paymentRef: 'COMPROBANTE-1' },
      undefined, undefined, [], { id: 'claim-1' },
    );
    await service.confirmManual('p1', 'Verificado otro banco y comprobante distinto', supervisor);
    expect(txPaymentRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: PaymentState.CONFIRMADO_MANUAL }));
    expect(txAuditRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      action: 'PAYMENT_CONFIRMED_MANUAL',
      metadata: expect.stringContaining('Verificado otro banco'),
    }));
  });

  it('rechaza la aprobación manual de cuenta Atlas aun con motivo y sin calce actual', async () => {
    const { service, txPaymentRepo, txAuditRepo } = makeService({ status: PaymentState.EN_REVISION, isAtlasAccount: true });
    await expect(service.confirmManual('p1', 'Verificado externamente', supervisor)).rejects.toThrow('concili');
    expect(txPaymentRepo.save).not.toHaveBeenCalled();
    expect(txAuditRepo.save).not.toHaveBeenCalled();
  });

  it('exige clasificar la cuenta histórica antes de aprobarla manualmente', async () => {
    const { service, txPaymentRepo, txAuditRepo } = makeService({ status: PaymentState.EN_REVISION, isAtlasAccount: null });
    await expect(service.confirmManual('p1', 'Verificado externamente', supervisor)).rejects.toThrow('banco de depósito');
    expect(txPaymentRepo.save).not.toHaveBeenCalled();
    expect(txAuditRepo.save).not.toHaveBeenCalled();
  });

  it('permite aprobar sin motivo una cuenta no Atlas si no hay calce ni toma bancaria riesgosa', async () => {
    const { service, txPaymentRepo } = makeService({ status: PaymentState.EN_REVISION, isAtlasAccount: false });
    await service.confirmManual('p1', undefined, supervisor);
    expect(txPaymentRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: PaymentState.CONFIRMADO_MANUAL }));
  });

  it('permite rechazar un comprobante inválido aun si la cuenta histórica sigue sin clasificar', async () => {
    const { service, txPaymentRepo } = makeService({ status: PaymentState.EN_REVISION, isAtlasAccount: null });
    await service.reject('p1', 'Comprobante inválido', supervisor);
    expect(txPaymentRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: PaymentState.RECHAZADO }));
  });

  it('no permite rechazar una consulta Atlas parcialmente conciliada', async () => {
    const { service, txPaymentRepo, txAuditRepo } = makeService({
      status: PaymentState.EN_REVISION, isAtlasAccount: true, allocatedAmount: 400,
    });
    await expect(service.reject('p1', 'No ingresó', supervisor)).rejects.toBeInstanceOf(ConflictException);
    expect(txPaymentRepo.save).not.toHaveBeenCalled();
    expect(txAuditRepo.save).not.toHaveBeenCalled();
  });

  it('no permite rechazar con toma bancaria activa aunque el acumulado esté desfasado', async () => {
    const { service, txPaymentRepo, txAuditRepo } = makeService(
      { status: PaymentState.EN_REVISION, allocatedAmount: 0 }, undefined,
      { receiptNumber: 'TR-000042' },
    );
    await expect(service.reject('p1', 'No ingresó', supervisor)).rejects.toThrow('TR-000042');
    expect(txPaymentRepo.save).not.toHaveBeenCalled();
    expect(txAuditRepo.save).not.toHaveBeenCalled();
  });

  it('la cantidad de movimientos Atlas no impide revisar un deposito BNF', async () => {
    const { service, txPaymentRepo } = makeService(
      { status: PaymentState.EN_REVISION, paymentRef: 'REF-1' },
      undefined, undefined, Array.from({ length: 5001 }, () => ({}) as BankTransfer),
    );
    await service.confirmManual('p1', undefined, supervisor);
    expect(txPaymentRepo.save).toHaveBeenCalled();
  });

  it.each([PaymentState.CONFIRMADO, PaymentState.CONFIRMADO_MANUAL, PaymentState.RECHAZADO])(
    'no permite rechazar un pago ya resuelto (%s)',
    async (status) => {
      const { service, txPaymentRepo } = makeService({ status });
      await expect(service.reject('p1', 'x', supervisor)).rejects.toBeInstanceOf(ConflictException);
      expect(txPaymentRepo.save).not.toHaveBeenCalled();
    },
  );

  it('no permite decidir un pago tomado por otro revisor', async () => {
    const { service } = makeService({
      status: PaymentState.PENDIENTE_VERIFICACION,
      reviewClaimedById: 'otro',
      reviewClaimedByName: 'Otro Supervisor',
      reviewClaimExpiresAt: new Date(Date.now() + 60_000),
    });
    await expect(service.reject('p1', 'x', supervisor)).rejects.toThrow('Otro Supervisor');
  });

  it('al anular una decision conciliada libera el movimiento', async () => {
    const movement = { id: 'm1', isReconciled: true } as Movement;
    const { service, txMovementRepo, txPaymentRepo } = makeService(
      { status: PaymentState.CONFIRMADO, matchedMovementId: 'm1' },
      movement,
    );
    await service.undoDecision('p1', supervisor);
    expect(txMovementRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', isReconciled: false }));
    expect(txPaymentRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: PaymentState.PENDIENTE_VERIFICACION, matchedMovementId: null }),
    );
  });
});

describe('Consultas conciliadas con el banco', () => {
  it('no se anulan por el flujo viejo: hay que anular la conciliacion en el panel', async () => {
    const { service, txPaymentRepo } = makeService({ status: PaymentState.CONFIRMADO }, undefined, { receiptNumber: 'TR-000042' });
    await expect(service.undoDecision('p1', supervisor)).rejects.toThrow('TR-000042');
    expect(txPaymentRepo.save).not.toHaveBeenCalled();
  });
});

describe('Acceso de cobradores a pagos ajenos', () => {
  const stored = {
    status: PaymentState.PENDIENTE_VERIFICACION,
    createdById: 'otro-cobrador',
    proofUrl: 'https://res.cloudinary.com/x/comprobante.jpg',
    observation: 'dato interno',
    fileHash: 'abc',
    proofDhash: 'def',
  };

  it('el detalle de un pago ajeno no incluye comprobante ni observacion', async () => {
    const { service } = makeService(stored);
    const view: any = await service.findOne('p1', collector);
    expect(view.proofUrl).toBeUndefined();
    expect(view.observation).toBeUndefined();
    expect(view.fileHash).toBeUndefined();
    expect(view.hasProof).toBe(true);
    expect(view.status).toBe(PaymentState.PENDIENTE_VERIFICACION);
  });

  it('el dueno y los supervisores ven el detalle completo', async () => {
    const { service } = makeService({ ...stored, createdById: 'col-1' });
    expect(((await service.findOne('p1', collector)) as any).proofUrl).toBe(stored.proofUrl);
    expect(((await service.findOne('p1', supervisor)) as any).proofUrl).toBe(stored.proofUrl);
  });

  it('la linea de vida de un pago ajeno llega sin metadatos', async () => {
    const { service, auditRepo, paymentRepo } = makeService(stored);
    auditRepo.find.mockResolvedValue([{ id: 'a1', action: 'PAYMENT_REJECTED', metadata: '{"reason":"x"}' }]);
    paymentRepo.findOne.mockResolvedValue({ id: 'p1', createdById: 'otro-cobrador' });
    const logs = await service.getAuditForPayment('p1', collector);
    expect(logs).toEqual([{ id: 'a1', action: 'PAYMENT_REJECTED', metadata: null }]);
  });

  it('un cobrador no puede registrar la impresion de un pago ajeno', async () => {
    const { service } = makeService({ ...stored, status: PaymentState.CONFIRMADO_MANUAL });
    await expect(service.markAsPrinted('p1', collector)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
