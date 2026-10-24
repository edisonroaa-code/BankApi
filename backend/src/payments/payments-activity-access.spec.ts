import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '../users/entities/user.entity';
import { PaymentsService } from './payments.service';

const collector = { userId: 'collector-1', role: UserRole.COBRADOR };

describe('activity and proof access', () => {
  const makeService = (payments: any[], logs: any[] = []) => {
    const paymentRepo = {
      findOne: jest.fn().mockResolvedValue(payments[0] ?? null),
      find: jest.fn().mockResolvedValue(payments),
    };
    const auditRepo = {
      find: jest.fn().mockResolvedValue(logs),
      create: jest.fn((value) => value),
      save: jest.fn(),
    };
    return { service: new PaymentsService(paymentRepo as any, auditRepo as any), auditRepo };
  };

  it('does not let a collector claim to have opened a foreign proof', async () => {
    const { service, auditRepo } = makeService([{ id: 'payment-1', createdById: 'other-user' }]);
    await expect(service.logProofViewed('payment-1', collector)).rejects.toBeInstanceOf(ForbiddenException);
    expect(auditRepo.save).not.toHaveBeenCalled();
  });

  it('does not log a proof view for a nonexistent payment', async () => {
    const { service, auditRepo } = makeService([]);
    await expect(service.logProofViewed('missing', collector)).rejects.toBeInstanceOf(NotFoundException);
    expect(auditRepo.save).not.toHaveBeenCalled();
  });

  it('removes foreign audit metadata from the shared collector activity', async () => {
    const logs = [
      { id: 'a1', paymentId: 'foreign', metadata: '{"secret":"foreign-details"}' },
      { id: 'a2', paymentId: 'own', metadata: '{"ref":"own-details"}' },
    ];
    const payments = [
      { id: 'foreign', createdById: 'other-user', amount: 1000 },
      { id: 'own', createdById: 'collector-1', amount: 2000 },
    ];
    const { service } = makeService(payments, logs);
    const activity = await service.listActivity(80, collector);
    expect(activity[0].metadata).toBeNull();
    expect(activity[1].metadata).toBe(logs[1].metadata);
  });
});
