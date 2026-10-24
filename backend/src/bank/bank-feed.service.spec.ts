import { AtlasApiError } from './atlas/atlas-client';
import { parseMovementsResponse } from './atlas/atlas-movements';
import { MANUAL_MOVIMIENTOS_DETALLE } from './atlas/atlas.fixtures';
import { readBankFeedConfig } from './bank-feed.config';
import { BankFeedService, BankFeedUnavailableError } from './bank-feed.service';
import { AtlasFeedSource } from './bank-feed.sources';

const DAYTIME = new Date('2026-09-19T14:00:00Z'); // 11:00 en Paraguay

const movement = (doc: number, reversado = 'N', monto = 20000) => {
  const base = MANUAL_MOVIMIENTOS_DETALLE.listaMovimiento[0];
  return {
    ...base,
    monto,
    numeroCuenta: '1870227',
    nroDocumento: doc,
    fechaMovimiento: '2026-09-19T10:30:00-03:00',
    infoAdicional: { ...base.infoAdicional, reversado },
  };
};

type FeedOptions = {
  subscribers?: number;
  fetch?: jest.Mock;
  connectedElsewhere?: number;
  /** Ultimo movimiento ya registrado antes de hoy (null: base sin historial, primer arranque). */
  lastStoredBefore?: Date | null;
  env?: Record<string, string>;
};

const makeFeed = (opts: FeedOptions = {}) => {
  const env = { BANK_FEED_MODE: 'atlas', BANK_FEED_ACCOUNT: '1870227', BANK_FEED_MAX_ROWS: '10', ...opts.env } as Record<string, string>;
  const config = readBankFeedConfig((k) => env[k]);
  const source = {
    fetch: opts.fetch ?? jest.fn().mockResolvedValue({ movements: [], verified: false, truncated: false }),
    fetchBalance: jest.fn().mockResolvedValue({ simulated: false, verified: true, balance: { nroCuenta: '1870227', saldo: 100 } }),
  };
  const transfers = {
    registerCredit: jest.fn(async (credit: any) => ({
      transfer: { id: `t-${credit.bankDocNumber}`, movementAt: credit.movementAt, reversedAt: credit.reversed ? new Date() : null },
      created: true,
      reversedNow: false,
    })),
    broadcast: jest.fn(),
  };
  // `subscribers`: paneles abiertos y visibles (sala de demanda). `connectedElsewhere`: sockets
  // con permiso para ver el feed pero en otra pantalla; no deben generar consultas al banco.
  const gateway = {
    countInRoom: jest.fn((room: string) =>
      room === 'bank-feed:demand' ? opts.subscribers ?? 1 : room.startsWith('bank-feed:') ? opts.connectedElsewhere ?? 0 : 0,
    ),
    emitToRoom: jest.fn(),
    onBankDemand: jest.fn(() => () => undefined),
  };
  const query: any = {
    select: () => query,
    where: () => query,
    getMany: async () => [],
    getRawOne: async () => ({ max: opts.lastStoredBefore ?? null }),
  };
  const dataSource = { getRepository: () => ({ createQueryBuilder: () => query }) };
  const feed = new BankFeedService(config, source as any, transfers as any, gateway as any, dataSource as any);
  return { feed, source, transfers, gateway };
};

const result = (list: unknown[], truncated = false) => ({
  movements: parseMovementsResponse({ listaMovimiento: list }),
  verified: false,
  truncated,
});

describe('Feed bancario', () => {
  it('registra una sola vez los créditos del sábado procesados el lunes al repetir el sondeo real', async () => {
    const now = new Date('2026-10-17T16:00:00Z');
    const config = readBankFeedConfig((k) => ({ BANK_FEED_MODE: 'atlas', BANK_FEED_ACCOUNT: '1870227' })[k]);
    const credits = parseMovementsResponse({ listaMovimiento: [228000, 472000].map((monto, i) => ({
      ...movement(1000 + i, 'N', monto),
      fechaMovimiento: i ? '2026-10-17T12:38:24-03:00' : '2026-10-17T12:16:50-03:00',
      'fecha Proceso': '2026-10-19T00:00:00-03:00',
    })) });
    const client = { consultarMovimientosDetallados: jest.fn(async (query) => ({
      movements: new Date(query.fecFin) >= new Date('2026-10-19T03:00:00Z') ? credits : [], verified: false,
    })) };
    const realSource = new AtlasFeedSource(client as any, config);
    const { feed, transfers } = makeFeed({ fetch: jest.fn((window) => realSource.fetch(window)) });
    await feed.tick(now);
    await feed.tick(new Date(now.getTime() + 5_000));
    expect(transfers.registerCredit).toHaveBeenCalledTimes(2);
    expect(feed.getStatus()).toMatchObject({ state: 'EN_VIVO', changeCount: 2 });
    expect(client.consultarMovimientosDetallados).toHaveBeenCalledTimes(2);
  });

  it('una app abierta en otra pantalla no consulta al banco: hace falta el panel visible', async () => {
    const { feed, source } = makeFeed({ subscribers: 0, connectedElsewhere: 3 });
    await feed.tick(DAYTIME);
    expect(source.fetch).not.toHaveBeenCalled();
    expect(feed.getStatus().state).toBe('EN_ESPERA');
  });

  it('el intervalo por defecto es de 5 segundos', () => {
    const { feed } = makeFeed();
    expect(feed.getStatus().intervalSeconds).toBe(5);
  });

  it('no consulta al banco si nadie tiene el panel abierto', async () => {
    const { feed, source } = makeFeed({ subscribers: 0 });
    await feed.tick(DAYTIME);
    expect(source.fetch).not.toHaveBeenCalled();
    expect(feed.getStatus().state).toBe('EN_ESPERA');
  });

  it('no consulta fuera del horario operativo', async () => {
    const { feed, source } = makeFeed();
    await feed.tick(new Date('2026-09-19T02:00:00Z')); // 23:00 local
    expect(source.fetch).not.toHaveBeenCalled();
    expect(feed.getStatus().state).toBe('FUERA_DE_HORARIO');
  });

  it('registra cada credito una sola vez aunque el banco lo repita en cada sondeo', async () => {
    const fetch = jest.fn().mockResolvedValue(result([movement(1), movement(2)]));
    const { feed, transfers } = makeFeed({ fetch });
    await feed.tick(DAYTIME);
    await feed.tick(new Date(DAYTIME.getTime() + 15_000));
    expect(transfers.registerCredit).toHaveBeenCalledTimes(2);
    expect(transfers.broadcast).toHaveBeenCalledWith(expect.objectContaining({ id: 't-1' }), 'bank-transfers:new');
    expect(feed.getStatus().state).toBe('EN_VIVO');
  });

  it('vuelve a procesar un credito ya visto cuando el banco lo reversa', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(result([movement(7)]))
      .mockResolvedValueOnce(result([movement(7, 'S')]));
    const { feed, transfers } = makeFeed({ fetch });
    await feed.tick(DAYTIME);
    await feed.tick(new Date(DAYTIME.getTime() + 15_000));
    expect(transfers.registerCredit).toHaveBeenCalledTimes(2);
    expect(transfers.registerCredit.mock.calls[1][0]).toMatchObject({ reversed: true });
  });

  it('parte la ventana cuando el banco devuelve el maximo de filas', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(result([], true))
      .mockResolvedValue(result([movement(3)]));
    const { feed } = makeFeed({ fetch });
    await feed.tick(DAYTIME);
    expect(fetch).toHaveBeenCalledTimes(3);
    const [older, newer] = [fetch.mock.calls[1][0], fetch.mock.calls[2][0]];
    expect(older.to.getTime()).toBe(newer.from.getTime());
  });

  it('se detiene ante credenciales invalidas en lugar de insistir', async () => {
    const fetch = jest.fn().mockRejectedValue(new AtlasApiError(401, 'Autenticacion invalida', 'cm1061'));
    const { feed } = makeFeed({ fetch });
    await feed.tick(DAYTIME);
    await feed.tick(new Date(DAYTIME.getTime() + 60_000));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(feed.getStatus()).toMatchObject({ state: 'DETENIDO', lastError: 'Autenticacion invalida' });
    feed.resume();
    expect(feed.getStatus().state).toBe('EN_ESPERA');
  });

  it('ante un error transitorio espera antes de reintentar', async () => {
    const fetch = jest.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(result([]));
    const { feed } = makeFeed({ fetch });
    await feed.tick(DAYTIME);
    await feed.tick(new Date(DAYTIME.getTime() + 5_000));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(feed.getStatus().state).toBe('ERROR');
    await feed.tick(new Date(DAYTIME.getTime() + 31_000));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(feed.getStatus().state).toBe('EN_VIVO');
  });
});

describe('Rescate de lo que entro sin nadie mirando', () => {
  const DAY_START = new Date('2026-09-19T03:00:00Z'); // 00:00 del 19 en Paraguay
  const LAST_NIGHT = new Date('2026-09-18T22:30:00Z'); // 19:30 del 18, ultimo registrado

  it('al abrir el primer panel del dia trae desde el ultimo movimiento registrado (noche, fin de semana)', async () => {
    const fetch = jest.fn().mockResolvedValue(result([]));
    const { feed } = makeFeed({ fetch, lastStoredBefore: LAST_NIGHT });
    await feed.tick(DAYTIME);
    // 15 minutos antes del ultimo registrado, por si el banco asienta alguno con hora anterior.
    expect(fetch.mock.calls[0][0].from).toEqual(new Date('2026-09-18T22:15:00Z'));
    await feed.tick(new Date(DAYTIME.getTime() + 15_000));
    expect(fetch.mock.calls[1][0].from).toEqual(DAY_START);
  });

  it('con la base sin historial (puesta en marcha) no importa nada anterior a hoy', async () => {
    const fetch = jest.fn().mockResolvedValue(result([]));
    const { feed } = makeFeed({ fetch, lastStoredBefore: null });
    await feed.tick(DAYTIME);
    expect(fetch.mock.calls[0][0].from).toEqual(DAY_START);
  });

  it('no mira mas de BANK_FEED_CATCHUP_DAYS hacia atras (4 por defecto)', async () => {
    const fetch = jest.fn().mockResolvedValue(result([]));
    const { feed } = makeFeed({ fetch, lastStoredBefore: new Date('2026-09-01T12:00:00Z') });
    await feed.tick(DAYTIME);
    expect(fetch.mock.calls[0][0].from).toEqual(new Date(DAYTIME.getTime() - 4 * 24 * 60 * 60 * 1000));
  });

  it('BANK_FEED_CATCHUP_DAYS=0 lo apaga', async () => {
    const fetch = jest.fn().mockResolvedValue(result([]));
    const { feed } = makeFeed({ fetch, lastStoredBefore: LAST_NIGHT, env: { BANK_FEED_CATCHUP_DAYS: '0' } });
    await feed.tick(DAYTIME);
    expect(fetch.mock.calls[0][0].from).toEqual(DAY_START);
  });

  it('si el banco falla durante el rescate, lo reintenta en el proximo sondeo', async () => {
    const fetch = jest.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(result([]));
    const { feed } = makeFeed({ fetch, lastStoredBefore: LAST_NIGHT });
    await feed.tick(DAYTIME);
    await feed.tick(new Date(DAYTIME.getTime() + 31_000));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0].from).toEqual(new Date('2026-09-18T22:15:00Z'));
  });

  it('registra el credito de anoche como cualquier otro', async () => {
    const lastNight = { ...movement(40), fechaMovimiento: '2026-09-18T21:10:00-03:00' };
    const fetch = jest.fn().mockResolvedValue(result([lastNight]));
    const { feed, transfers } = makeFeed({ fetch, lastStoredBefore: LAST_NIGHT });
    await feed.tick(DAYTIME);
    expect(transfers.registerCredit).toHaveBeenCalledWith(expect.objectContaining({ bankDocNumber: '40' }));
  });
});

describe('Fuente Atlas', () => {
  it('no filtra por tipo de movimiento en el banco: el sandbox se cae con "C" y los creditos se filtran aca', async () => {
    const client = { consultarMovimientosDetallados: jest.fn().mockResolvedValue({ movements: [], verified: false }) };
    const config = readBankFeedConfig((k) => ({ BANK_FEED_MODE: 'atlas', BANK_FEED_ACCOUNT: '1870227' } as Record<string, string>)[k]);
    await new AtlasFeedSource(client as any, config).fetch({ from: DAYTIME, to: DAYTIME, includeReversed: true } as any);
    const params = client.consultarMovimientosDetallados.mock.calls[0][0];
    expect(params).not.toHaveProperty('tipoMovimiento');
    expect(params).toMatchObject({ numeroCuenta: '1870227', incluyeReversa: true });
  });
});

describe('Saldo a pedido del admin', () => {
  it('se consulta una vez aunque se pida varias veces seguidas', async () => {
    const { feed, source } = makeFeed();
    const [a, b] = await Promise.all([feed.getBalance(), feed.getBalance()]);
    await feed.getBalance();
    expect(source.fetchBalance).toHaveBeenCalledTimes(1);
    expect(a.balance.saldo).toBe(100);
    expect(b.consultedAt).toEqual(expect.any(String));
  });

  it('no consulta al banco si el feed quedo detenido por credenciales', async () => {
    const fetch = jest.fn().mockRejectedValue(new AtlasApiError(401, 'Autenticacion invalida'));
    const { feed, source } = makeFeed({ fetch });
    await feed.tick(DAYTIME);
    await expect(feed.getBalance()).rejects.toBeInstanceOf(BankFeedUnavailableError);
    expect(source.fetchBalance).not.toHaveBeenCalled();
  });
});

describe('Boton Actualizar compartido', () => {
  const later = (seconds: number) => new Date(DAYTIME.getTime() + seconds * 1000);
  const tickOver = () => new Promise((r) => setImmediate(r));
  const deferredFetch = () => {
    const calls: Array<(value: any) => void> = [];
    const fetch = jest.fn(() => new Promise((resolve) => calls.push(resolve)));
    return { fetch, answer: (list: unknown[] = []) => calls.shift()!(result(list)) };
  };

  it('una persona actualiza: responde recien cuando el banco contesto, con lo nuevo ya guardado', async () => {
    const { fetch, answer } = deferredFetch();
    const { feed, transfers, gateway } = makeFeed({ fetch });
    const pending = feed.requestRefresh('Hugo', DAYTIME);
    // La espera compartida arranca en el acto, antes de que llegue la respuesta del banco.
    expect(feed.getStatus().lastPollAt).toBe(DAYTIME.toISOString());
    let answered = false;
    void pending.then(() => (answered = true));
    await tickOver();
    expect(answered).toBe(false);
    answer([movement(1)]);
    const response = await pending;
    expect(response.accepted).toBe(true);
    // La pantalla relee la lista al recibir la respuesta: la transferencia ya tiene que estar guardada.
    expect(transfers.registerCredit).toHaveBeenCalledTimes(1);
    expect(response.status).toMatchObject({ lastRefreshBy: 'Hugo', changeCount: 1, refreshCooldownSeconds: 5 });
    expect(gateway.emitToRoom).toHaveBeenCalledWith('bank-feed:masked', 'bank-feed:status', expect.objectContaining({ lastRefreshBy: 'Hugo' }));
  });

  it('quien aprieta Actualizar esta mirando: consulta aunque su panel figure como oculto', async () => {
    const { feed, source } = makeFeed({ subscribers: 0 });
    expect(await feed.requestRefresh('Hugo', DAYTIME)).toMatchObject({ accepted: true });
    expect(source.fetch).toHaveBeenCalledTimes(1);
    // El ciclo automatico sigue necesitando un panel visible.
    await feed.tick(later(30));
    expect(source.fetch).toHaveBeenCalledTimes(1);
  });

  it('varias pantallas comparten la espera y consultan exactamente desde los 5 segundos', async () => {
    const { feed, source } = makeFeed();
    await feed.requestRefresh('Hugo', DAYTIME);
    for (const [who, at] of [['Rosa', 2], ['Taty', 4], ['Luis', 4.999]] as const) {
      expect(await feed.requestRefresh(who, later(at))).toMatchObject({ accepted: false, reason: 'RECIENTE' });
    }
    expect(source.fetch).toHaveBeenCalledTimes(1);
    expect((await feed.requestRefresh('Rosa', later(5))).accepted).toBe(true);
    expect(source.fetch).toHaveBeenCalledTimes(2);
  });

  it('una consulta lenta no se duplica: quien aprieta durante ella espera su resultado', async () => {
    const { fetch, answer } = deferredFetch();
    const { feed } = makeFeed({ fetch });
    const first = feed.requestRefresh('Caja uno', DAYTIME);
    await tickOver();
    let secondDone = false;
    const second = feed.requestRefresh('Caja dos', later(5)).then((r) => {
      secondDone = true;
      return r;
    });
    await feed.tick(later(5));
    await tickOver();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(secondDone).toBe(false);
    answer();
    expect(await second).toMatchObject({ accepted: true });
    expect((await first).accepted).toBe(true);

    const third = feed.requestRefresh('Caja dos', later(6));
    await tickOver();
    expect(fetch).toHaveBeenCalledTimes(2);
    answer();
    expect((await third).accepted).toBe(true);
  });

  it('a los 20 s no anuncia una consulta terminada y conserva la unica consulta en curso', async () => {
    jest.useFakeTimers();
    try {
      const { fetch, answer } = deferredFetch();
      const { feed } = makeFeed({ fetch });
      const pending = feed.requestRefresh('Caja uno', DAYTIME);
      await jest.advanceTimersByTimeAsync(20_000);
      expect(await pending).toMatchObject({ accepted: false, reason: 'EN_CURSO' });
      expect(feed.getStatus().lastSuccessAt).toBeNull();
      const shared = feed.requestRefresh('Caja dos', later(21));
      expect(fetch).toHaveBeenCalledTimes(1);
      answer([movement(1)]);
      expect(await shared).toMatchObject({ accepted: true, status: { changeCount: 1 } });
    } finally {
      jest.useRealTimers();
    }
  });

  it('el contador de cambios avanza solo con transferencias nuevas, para recuperar avisos perdidos', async () => {
    const fetch = jest.fn().mockResolvedValue(result([movement(1), movement(2)]));
    const { feed } = makeFeed({ fetch });
    await feed.tick(DAYTIME);
    expect(feed.getStatus().changeCount).toBe(2);
    await feed.tick(later(5));
    expect(feed.getStatus().changeCount).toBe(2);
  });

  it('el estado lleva la hora del servidor para que la cuenta regresiva no dependa del reloj de cada PC', () => {
    const { feed } = makeFeed();
    expect(feed.getStatus().serverTime).toEqual(expect.any(String));
  });

  it('fuera de horario o con la consulta detenida no se consulta al banco', async () => {
    const night = new Date('2026-09-20T03:00:00Z'); // 00:00 en Paraguay
    const { feed, source } = makeFeed();
    expect(await feed.requestRefresh('Hugo', night)).toMatchObject({ accepted: false, reason: 'FUERA_DE_HORARIO' });

    const fetch = jest.fn().mockRejectedValue(new AtlasApiError(401, 'Autenticacion invalida'));
    const stopped = makeFeed({ fetch });
    await stopped.feed.tick(DAYTIME);
    expect(await stopped.feed.requestRefresh('Hugo', later(30))).toMatchObject({ accepted: false, reason: 'DETENIDO' });
    expect(source.fetch).not.toHaveBeenCalled();
  });
});
