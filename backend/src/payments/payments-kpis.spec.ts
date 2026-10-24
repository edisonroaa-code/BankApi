import { PaymentsService } from './payments.service';
import { PaymentState } from './entities/payment.entity';

describe('PaymentsService collector KPIs', () => {
  it('attributes a monthly collection to its creation month even when it is approved later', async () => {
    const claimsQuery = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(0),
    };
    const collectorQuery = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        {
          createdbyid: 'collector-1',
          amount: '250000',
          status: PaymentState.CONFIRMADO,
          createdat: '2026-07-31T22:30:00.000Z',
          verifiedat: '2026-08-01T00:10:00.000Z',
        },
      ]),
    };
    const auditQuery = {
      leftJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    const userRepo = {
      find: jest.fn().mockResolvedValue([
        {
          id: 'collector-1',
          name: 'Cobrador Uno',
          username: 'cobrador1',
          role: 'COBRADOR',
        },
      ]),
    };
    const paymentRepo = {
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest
        .fn()
        .mockReturnValueOnce(claimsQuery)
        .mockReturnValueOnce(collectorQuery),
      manager: { getRepository: jest.fn().mockReturnValue(userRepo) },
    };
    const auditRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(auditQuery),
    };
    const service = new PaymentsService(
      paymentRepo as any,
      auditRepo as any,
    );

    const result = await service.getKpis({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
    });

    expect(result.byCollector).toEqual([
      expect.objectContaining({
        userId: 'collector-1',
        name: 'Cobrador Uno',
        resolved: 1,
        approved: 1,
        rejected: 0,
        sumApproved: 250000,
        sumRejected: 0,
      }),
    ]);
    expect(collectorQuery.where).toHaveBeenCalledWith(
      'payment.createdAt >= :start',
      expect.any(Object),
    );
  });

  it('uses the entire current month when no KPI range is provided', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-15T15:00:00.000Z'));
    try {
      const claimsQuery = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      };
      const collectorQuery = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      const auditQuery = {
        leftJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      const paymentRepo = {
        count: jest.fn().mockResolvedValue(0),
        createQueryBuilder: jest
          .fn()
          .mockReturnValueOnce(claimsQuery)
          .mockReturnValueOnce(collectorQuery),
        manager: {
          getRepository: jest
            .fn()
            .mockReturnValue({ find: jest.fn().mockResolvedValue([]) }),
        },
      };
      const service = new PaymentsService(
        paymentRepo as any,
        {
          createQueryBuilder: jest.fn().mockReturnValue(auditQuery),
        } as any,
      );

      await service.getKpis();

      const start = collectorQuery.where.mock.calls.find(
        ([sql]: [string]) => sql === 'payment.createdAt >= :start',
      )[1].start as Date;
      const end = collectorQuery.andWhere.mock.calls.find(
        ([sql]: [string]) => sql === 'payment.createdAt <= :end',
      )[1].end as Date;
      expect([
        start.getFullYear(),
        start.getMonth(),
        start.getDate(),
        start.getHours(),
      ]).toEqual([2026, 6, 1, 0]);
      expect([
        end.getFullYear(),
        end.getMonth(),
        end.getDate(),
        end.getHours(),
        end.getMinutes(),
      ]).toEqual([2026, 6, 31, 23, 59]);
    } finally {
      jest.useRealTimers();
    }
  });
});
