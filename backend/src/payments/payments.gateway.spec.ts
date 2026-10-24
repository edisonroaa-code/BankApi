import { PaymentsGateway, userRoom } from './payments.gateway';
import { roomsForRole } from './realtime-rooms';
import { UserAccessEventsService } from '../users/user-access-events.service';

describe('PaymentsGateway', () => {
  const makeGateway = () => {
    const accessEvents = new UserAccessEventsService();
    const gateway = new PaymentsGateway({} as any, {} as any, accessEvents);
    return { gateway, accessEvents };
  };

  it('broadcasts the payment owner as the notification target', () => {
    const { gateway } = makeGateway();
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    (gateway as any).server = { to };

    gateway.emitPaymentsChanged({
      type: 'PAYMENT_REJECTED',
      paymentId: 'payment-1',
      targetUserId: 'collector-1',
      ts: '2026-06-23T12:00:00.000Z',
    });

    expect(to).toHaveBeenCalledWith('payments');
    expect(emit).toHaveBeenCalledWith('payments:changed', {
      type: 'PAYMENT_REJECTED',
      paymentId: 'payment-1',
      targetUserId: 'collector-1',
      ts: '2026-06-23T12:00:00.000Z',
    });
  });

  it('disconnects every socket of a user whose access was revoked', () => {
    const { gateway, accessEvents } = makeGateway();
    const disconnectSockets = jest.fn();
    const inRoom = jest.fn().mockReturnValue({ disconnectSockets });
    (gateway as any).server = { in: inRoom };

    accessEvents.emitAccessRevoked('cashier-1');

    expect(inRoom).toHaveBeenCalledWith(userRoom('cashier-1'));
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });

  it('joins the authenticated user to its own room and rejects inactive users', async () => {
    const jwtService = { verifyAsync: jest.fn().mockResolvedValue({ sub: 'u1', tokenVersion: 0, exp: Math.floor(Date.now() / 1000) + 3600 }) };
    const usersService = {
      findOneById: jest
        .fn()
        .mockResolvedValueOnce({ id: 'u1', username: 'hugo', role: 'COBRADOR', isActive: true, tokenVersion: 0 })
        .mockResolvedValueOnce({ id: 'u1', username: 'hugo', role: 'COBRADOR', isActive: false, tokenVersion: 0 }),
    };
    const gateway = new PaymentsGateway(jwtService as any, usersService as any, new UserAccessEventsService());
    const makeClient = () => ({
      handshake: { auth: { token: 't' }, query: {} },
      data: {} as any,
      join: jest.fn(),
      disconnect: jest.fn(),
    });

    const active = makeClient();
    await gateway.handleConnection(active as any);
    // El cobrador tambien entra al feed del banco: concilia sus consultas contra lo que va entrando.
    expect(active.join).toHaveBeenCalledWith([userRoom('u1'), 'payments', 'bank-feed:full']);
    expect(active.disconnect).not.toHaveBeenCalled();

    const inactive = makeClient();
    await gateway.handleConnection(inactive as any);
    expect(inactive.join).not.toHaveBeenCalled();
    expect(inactive.disconnect).toHaveBeenCalledWith(true);
  });

  it('el cajero entra solo a la sala enmascarada del feed, no a la de consultas', async () => {
    const gateway = new PaymentsGateway(
      { verifyAsync: jest.fn().mockResolvedValue({ sub: 'c1', tokenVersion: 0, exp: Math.floor(Date.now() / 1000) + 3600 }) } as any,
      { findOneById: jest.fn().mockResolvedValue({ id: 'c1', username: 'hugo', role: 'CAJERO', isActive: true, tokenVersion: 0 }) } as any,
      new UserAccessEventsService(),
    );
    const client = { handshake: { auth: { token: 't' }, query: {} }, data: {} as any, join: jest.fn(), disconnect: jest.fn() };
    await gateway.handleConnection(client as any);
    expect(client.join).toHaveBeenCalledWith([userRoom('c1'), 'bank-feed:masked']);
  });

  describe('demanda del panel de transferencias', () => {
    const socketFor = (role: string) => {
      const rooms = new Set<string>();
      return {
        data: { user: { userId: 'u1', role } } as Record<string, any>,
        connected: true,
        rooms,
        join: jest.fn(async (room: string) => void rooms.add(room)),
        leave: jest.fn(async (room: string) => void rooms.delete(room)),
      };
    };
    const withRoomCount = (gateway: PaymentsGateway, count: () => number) => {
      (gateway as any).server = { adapter: { rooms: new Map([['bank-feed:demand', { get size() { return count(); } }]]) } };
    };

    it('los roles que ven el feed abren y cierran demanda; el supervisor tambien (solo lectura)', async () => {
      for (const role of ['ADMIN', 'COBRADOR', 'CAJERO', 'SUPERVISOR']) {
        const { gateway } = makeGateway();
        const client = socketFor(role);
        await expect(gateway.openBankPanel(client as any)).resolves.toEqual({ ok: true });
        expect(client.rooms.has('bank-feed:demand')).toBe(true);
        await gateway.closeBankPanel(client as any);
        expect(client.rooms.has('bank-feed:demand')).toBe(false);
      }
    });

    it('un socket sin rol habilitado no genera consultas al banco', async () => {
      const { gateway } = makeGateway();
      const client = socketFor('OTRO');
      await expect(gateway.openBankPanel(client as any)).resolves.toEqual({ ok: false });
      expect(client.join).not.toHaveBeenCalled();
    });

    it('avisa al feed solo cuando se abre el primer panel', async () => {
      const { gateway } = makeGateway();
      let open = 0;
      withRoomCount(gateway, () => open);
      const listener = jest.fn();
      gateway.onBankDemand(listener);
      const first = socketFor('CAJERO');
      first.join.mockImplementation(async () => void (open += 1));
      await gateway.openBankPanel(first as any);
      const second = socketFor('ADMIN');
      second.join.mockImplementation(async () => void (open += 1));
      await gateway.openBankPanel(second as any);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('un panel que avisa apenas conecta espera la autenticacion en vez de ser rechazado', async () => {
      // Reproduce lo visto en vivo: socket.io entrega el mensaje antes de que termine handleConnection.
      const { gateway } = makeGateway();
      const client = socketFor('SUPERVISOR');
      let finishAuth!: () => void;
      client.data = { ready: new Promise<void>((resolve) => (finishAuth = resolve)) };
      const pending = gateway.openBankPanel(client as any);
      client.data.user = { userId: 'u1', role: 'SUPERVISOR' };
      finishAuth();
      await expect(pending).resolves.toEqual({ ok: true });
      expect(client.rooms.has('bank-feed:demand')).toBe(true);
    });

    it('si la autenticacion fallo y el socket se cerro, el aviso no abre demanda', async () => {
      const { gateway } = makeGateway();
      const client = socketFor('ADMIN');
      client.connected = false;
      await expect(gateway.openBankPanel(client as any)).resolves.toEqual({ ok: false });
    });

    it('conectarse no abre demanda: la sala la abre solo el panel', async () => {
      expect(roomsForRole('ADMIN')).not.toContain('bank-feed:demand');
      expect(roomsForRole('SUPERVISOR')).toEqual(['payments', 'bank-feed:masked']);
    });
  });

  it('rejects a websocket handshake using a pre-reset token', async () => {
    const gateway = new PaymentsGateway(
      { verifyAsync: jest.fn().mockResolvedValue({ sub: 'u1', tokenVersion: 1, exp: Math.floor(Date.now() / 1000) + 3600 }) } as any,
      { findOneById: jest.fn().mockResolvedValue({ id: 'u1', role: 'CAJERO', isActive: true, tokenVersion: 2 }) } as any,
      new UserAccessEventsService(),
    );
    const client = {
      handshake: { auth: { token: 'test-token' }, query: {} }, data: {}, join: jest.fn(), disconnect: jest.fn(),
    };

    await gateway.handleConnection(client as any);

    expect(client.join).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnects an authenticated socket when its JWT expires', async () => {
    jest.useFakeTimers();
    try {
      const gateway = new PaymentsGateway(
        { verifyAsync: jest.fn().mockResolvedValue({ sub: 'u1', tokenVersion: 0, exp: Math.floor(Date.now() / 1000) + 1 }) } as any,
        { findOneById: jest.fn().mockResolvedValue({ id: 'u1', role: 'CAJERO', isActive: true, tokenVersion: 0 }) } as any,
        new UserAccessEventsService(),
      );
      const client = {
        handshake: { auth: { token: 'test-token' }, query: {} },
        data: {}, join: jest.fn(), once: jest.fn(), disconnect: jest.fn(),
      };

      await gateway.handleConnection(client as any);
      expect(client.join).toHaveBeenCalled();
      jest.advanceTimersByTime(1100);
      expect(client.disconnect).toHaveBeenCalledWith(true);
      gateway.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
