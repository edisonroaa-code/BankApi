import { PaymentsService } from './payments.service';
import { UserRole } from '../users/entities/user.entity';

describe('PaymentsService Atlas paged filter', () => {
  it('filters before pagination and count without changing the requested page', async () => {
    const queryBuilder: Record<string, jest.Mock> = {};
    for (const method of ['leftJoinAndSelect', 'select', 'andWhere', 'orderBy', 'addOrderBy', 'take', 'skip']) {
      queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
    }
    queryBuilder.getManyAndCount = jest.fn().mockResolvedValue([[], 3]);
    const paymentRepo = { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) };
    const service = new PaymentsService(paymentRepo as any, {} as any);

    const result = await service.findAllPaged(
      { isAtlasAccount: true, page: 2, pageSize: 2 },
      { userId: 'admin-1', role: UserRole.ADMIN },
    );

    expect(queryBuilder.andWhere).toHaveBeenCalledWith('payment.isAtlasAccount = :isAtlasAccount', { isAtlasAccount: true });
    expect(queryBuilder.take).toHaveBeenCalledWith(2);
    expect(queryBuilder.skip).toHaveBeenCalledWith(2);
    expect(result).toMatchObject({ total: 3, page: 2, pageSize: 2, totalPages: 2 });
  });
});
