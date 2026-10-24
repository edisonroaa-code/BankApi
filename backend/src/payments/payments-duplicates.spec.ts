import { BadRequestException, ConflictException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { Payment, PaymentState } from './entities/payment.entity';
import { AuditLog } from './entities/audit-log.entity';

const createService = (overrides: Record<string, any> = {}) => {
  const paymentRepo = {
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => ({ id: 'new-payment', status: PaymentState.PENDIENTE_VERIFICACION, ...value })),
    ...overrides,
  };
  const auditRepo = {
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => value),
  };
  const manager: any = {
    getRepository: jest.fn((entity) => entity === Payment ? paymentRepo : entity === AuditLog ? auditRepo : null),
  };
  manager.transaction = jest.fn(async (callback) => callback(manager));
  (paymentRepo as any).manager = manager;
  const service = new PaymentsService(paymentRepo as any, auditRepo as any);
  return { service, paymentRepo, auditRepo, manager };
};

describe('PaymentsService duplicate prevention', () => {
  it('requires an explicit destination-account classification even for internal callers', async () => {
    const { service, paymentRepo } = createService();
    await expect(service.create({ paymentRef: 'REF-NEW' }, { userId: 'collector-1' }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(paymentRepo.save).not.toHaveBeenCalled();
  });

  it('rejects an exact duplicate file hash', async () => {
    const { service, paymentRepo } = createService({
      findOne: jest.fn().mockResolvedValue({ id: 'existing', paymentRef: 'REF-1' }),
    });

    await expect(service.create(
      { fileHash: 'same-sha256', paymentRef: 'REF-2', isAtlasAccount: false },
      { userId: 'collector-1' },
    )).rejects.toBeInstanceOf(ConflictException);
    expect(paymentRepo.save).not.toHaveBeenCalled();
  });

  it('rejects a duplicate payment reference', async () => {
    const { service, paymentRepo } = createService({
      findOne: jest.fn().mockResolvedValue({ id: 'existing', paymentRef: 'REF-1' }),
    });

    await expect(service.create(
      { paymentRef: 'REF-1', isAtlasAccount: false },
      { userId: 'collector-1' },
    )).rejects.toBeInstanceOf(ConflictException);
    expect(paymentRepo.save).not.toHaveBeenCalled();
  });

  it('translates a concurrent unique-index violation into a conflict', async () => {
    const { service, paymentRepo } = createService({
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockRejectedValue({ driverError: { code: '23505' } }),
    });

    await expect(service.create(
      { paymentRef: 'REF-NEW', fileHash: 'hash-new', isAtlasAccount: false },
      { userId: 'collector-1' },
    )).rejects.toBeInstanceOf(ConflictException);
    expect(paymentRepo.save).toHaveBeenCalledTimes(1);
  });

  it('writes creation and its audit in one transaction', async () => {
    const { service, paymentRepo, auditRepo, manager } = createService({
      findOne: jest.fn().mockResolvedValue(null),
    });
    await service.create({ paymentRef: 'REF-NEW', isAtlasAccount: false }, { userId: 'collector-1' });
    expect(manager.transaction).toHaveBeenCalledTimes(1);
    expect(paymentRepo.save).toHaveBeenCalledTimes(1);
    expect(auditRepo.save).toHaveBeenCalledTimes(1);
    expect(manager.getRepository).toHaveBeenCalledWith(AuditLog);
  });

  it('rejects a perceptually equal proof for the same client, amount and bank', async () => {
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        {
          id: 'existing',
          paymentRef: 'REF-1',
          proofDhash: '0123456789abcdef',
          status: PaymentState.PENDIENTE_VERIFICACION,
        },
      ]),
    };
    const { service, paymentRepo } = createService({
      createQueryBuilder: jest.fn(() => queryBuilder),
    });

    await expect(service.create(
      {
        amount: 100000,
        clientCode: 'CLIENT-1',
        sourceBank: 'BANCO',
        paymentRef: 'REF-1',
        proofDhash: '0123456789abcdef',
        isAtlasAccount: false,
      },
      { userId: 'collector-1' },
    )).rejects.toBeInstanceOf(ConflictException);
    expect(paymentRepo.save).not.toHaveBeenCalled();
  });
});
