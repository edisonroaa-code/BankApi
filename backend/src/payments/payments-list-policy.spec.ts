import { PaymentState } from './entities/payment.entity';
import { enforcePaymentsListScope, normalizePaymentsPage } from './payments-list-policy';
import { UserRole } from '../users/entities/user.entity';

describe('payments list policy', () => {
  it('forces collectors to query only their own payments', () => {
    const query = enforcePaymentsListScope(
      { createdById: 'another-user', pageSize: 500 },
      { userId: 'collector-1', role: UserRole.COBRADOR },
    );

    expect(query.createdById).toBe('collector-1');
  });

  it('keeps the shared work panel global for collectors', () => {
    const query = enforcePaymentsListScope(
      { globalScope: true, pageSize: 50 },
      { userId: 'collector-1', role: UserRole.COBRADOR },
    );

    expect(query.createdById).toBeUndefined();
    expect(query.globalScope).toBe(true);
  });

  it('keeps administrator filters unchanged', () => {
    const query = enforcePaymentsListScope(
      { createdById: 'collector-2', status: PaymentState.RECHAZADO },
      { userId: 'admin-1', role: UserRole.ADMIN },
    );

    expect(query.createdById).toBe('collector-2');
    expect(query.status).toBe(PaymentState.RECHAZADO);
  });

  it('limits pages to one hundred lightweight records', () => {
    expect(normalizePaymentsPage({ page: 0, pageSize: 500 })).toEqual({
      page: 1,
      pageSize: 100,
      offset: 0,
    });
  });
});
