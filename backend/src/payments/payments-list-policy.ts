import { ListPaymentsQueryDto } from './dto/list-payments-query.dto';
import { UserRole } from '../users/entities/user.entity';

type ListActor = { userId: string; role?: UserRole | string };

export const enforcePaymentsListScope = (
  query: ListPaymentsQueryDto = {},
  actor?: ListActor,
): ListPaymentsQueryDto => {
  const scoped = { ...query, lite: true };
  if (actor?.role === UserRole.COBRADOR && !scoped.globalScope) {
    scoped.createdById = actor.userId;
  }
  return scoped;
};

export const normalizePaymentsPage = (query: ListPaymentsQueryDto = {}) => {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.max(1, Math.min(100, Number(query.pageSize) || 50));
  return { page, pageSize, offset: (page - 1) * pageSize };
};
