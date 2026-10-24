import { BankTransfersService } from './bank-transfers.service';
import { BankTransfer, BankTransferStatus } from './entities/bank-transfer.entity';
import { UserRole } from '../users/entities/user.entity';

const cashier = { userId: 'u1', username: 'cajero', role: UserRole.CAJERO };

/** Query builder falso: anota cada llamada y responde segun para que se uso. */
const makeService = (options: { rows?: Partial<BankTransfer>[]; byStatus?: Array<{ status: BankTransferStatus; n: string }>; pending?: Date[] } = {}) => {
  const builders: any[] = [];
  const repo = {
    createQueryBuilder: () => {
      const calls: Array<[string, unknown[]]> = [];
      const qb: any = new Proxy({}, {
        get: (_target, prop: string) => {
          if (prop === 'calls') return calls;
          if (prop === 'getManyAndCount') return async () => [options.rows ?? [], (options.rows ?? []).length];
          if (prop === 'getRawMany') {
            return async () => (calls.some(([name]) => name === 'groupBy') ? options.byStatus ?? [] : (options.pending ?? []).map((movementAt) => ({ movementAt })));
          }
          return (...args: unknown[]) => {
            calls.push([prop, args]);
            return qb;
          };
        },
      });
      builders.push(qb);
      return qb;
    },
  };
  const manager = { getRepository: () => ({ find: async () => [] }) };
  const dataSource = { getRepository: () => repo, manager };
  const config = { tzOffset: '-03:00', tzOffsetMinutes: -180 };
  return { service: new BankTransfersService(dataSource as any, {} as any, config as any), builders };
};

const params = (qb: any, method: string) => qb.calls.filter(([name]: [string]) => name === method).map(([, args]: [string, unknown[]]) => args);

describe('Panel de transferencias por mes', () => {
  it('toma el mes completo en hora de Paraguay, tambien diciembre → enero', async () => {
    const { service, builders } = makeService();
    await service.listPage({ month: '2026-12' }, cashier);
    const [, range] = params(builders[0], 'where')[0];
    expect(range).toEqual({ from: new Date('2026-12-01T03:00:00Z'), to: new Date('2027-01-01T03:00:00Z') });
  });

  it('Disponibles trae lo que tiene saldo para tomar, paginado', async () => {
    const { service, builders } = makeService();
    const page = await service.listPage({ month: '2026-10', view: 'DISPONIBLES', page: 3, pageSize: 10 }, cashier);
    expect(params(builders[0], 'andWhere')[0]).toEqual(['t.status IN (:...statuses)', { statuses: [BankTransferStatus.DISPONIBLE, BankTransferStatus.PARCIAL] }]);
    expect(params(builders[0], 'skip')[0]).toEqual([20]);
    expect(params(builders[0], 'take')[0]).toEqual([10]);
    expect(page).toMatchObject({ month: '2026-10', view: 'DISPONIBLES', page: 3, pageSize: 10 });
  });

  it('cuenta cada pestaña en el mes entero', async () => {
    const { service } = makeService({
      byStatus: [
        { status: BankTransferStatus.DISPONIBLE, n: '2' },
        { status: BankTransferStatus.PARCIAL, n: '1' },
        { status: BankTransferStatus.TOMADA, n: '4' },
        { status: BankTransferStatus.REVERSADA, n: '1' },
      ],
    });
    const page = await service.listPage({ month: '2026-10' }, cashier);
    expect(page.counts).toEqual({ DISPONIBLES: 3, TOMADAS: 5, REVISAR: 1, TODAS: 8 });
  });

  it('avisa lo que quedo sin tomar en otros meses, agrupado por mes de Paraguay', async () => {
    const { service } = makeService({
      pending: [new Date('2026-10-01T02:00:00Z'), new Date('2026-09-15T15:00:00Z'), new Date('2026-08-31T20:00:00Z')],
    });
    const page = await service.listPage({ month: '2026-10' }, cashier);
    // 01/10 a las 02:00 UTC fue el 30/09 a las 23:00 en Paraguay.
    expect(page.pendingOtherMonths).toEqual([{ month: '2026-09', count: 2 }, { month: '2026-08', count: 1 }]);
  });

  it('una página demasiado grande se limita a 200', async () => {
    const { service, builders } = makeService();
    await service.listPage({ month: '2026-10', pageSize: 5000 }, cashier);
    expect(params(builders[0], 'take')[0]).toEqual([200]);
  });
});
