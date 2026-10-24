import { AtlasFeedSource } from './bank-feed.sources';
import { readBankFeedConfig } from './bank-feed.config';
import { parseMovementsResponse } from './atlas/atlas-movements';
import { MANUAL_MOVIMIENTOS_DETALLE } from './atlas/atlas.fixtures';

const config = readBankFeedConfig((key) => ({ BANK_FEED_MODE: 'atlas', BANK_FEED_ACCOUNT: '1870227' })[key]);
const from = new Date('2026-10-17T03:00:00Z');
const to = new Date('2026-10-17T16:00:00Z');
const rows = parseMovementsResponse({ listaMovimiento: [228000, 472000].map((monto, i) => ({
  ...MANUAL_MOVIMIENTOS_DETALLE.listaMovimiento[0],
  monto, nroDocumento: i + 100, numeroCuenta: config.account,
  fechaMovimiento: i ? '2026-10-17T12:38:24-03:00' : '2026-10-17T12:16:50-03:00',
  'fecha Proceso': '2026-10-19T00:00:00-03:00',
})) });

describe('Atlas: fecha de proceso posterior al movimiento', () => {
  it('recupera el sábado los créditos de hoy cuya fecha de proceso es el lunes', async () => {
    // Reproduce el banco real: fecFin=17/10 devuelve cero; con 19/10 aparecen los dos créditos.
    const client = { consultarMovimientosDetallados: jest.fn(async (query) => ({
      movements: new Date(query.fecFin) >= new Date('2026-10-19T03:00:00Z') ? rows : [], verified: false,
    })) };
    const result = await new AtlasFeedSource(client as any, config).fetch({ from, to, includeReversed: true });
    expect(result.movements.map((m) => m.monto)).toEqual([228000, 472000]);
    expect(client.consultarMovimientosDetallados).toHaveBeenCalledTimes(1);
  });

  it('no admite movimientos con hora real futura ni anteriores a la ventana pedida', async () => {
    const outside = [
      { ...rows[0], fechaMovimiento: '2026-10-16T23:59:59-03:00' },
      { ...rows[0], fechaMovimiento: '2026-10-17T13:00:01-03:00' },
      { ...rows[0], fechaMovimiento: '2026-10-19T09:00:00-03:00' },
    ];
    const client = { consultarMovimientosDetallados: jest.fn().mockResolvedValue({ movements: [...rows, ...outside], verified: true }) };
    const result = await new AtlasFeedSource(client as any, config).fetch({ from, to, includeReversed: true });
    expect(result.movements).toEqual(rows);
    expect(result.verified).toBe(true);
  });

  it('conserva los dos extremos inclusive del intervalo de movimiento', async () => {
    const edges = [from, to].map((date) => ({ ...rows[0], fechaMovimiento: date.toISOString() }));
    const client = { consultarMovimientosDetallados: jest.fn().mockResolvedValue({ movements: edges, verified: false }) };
    expect((await new AtlasFeedSource(client as any, config).fetch({ from, to, includeReversed: true })).movements).toEqual(edges);
  });

  it('detecta truncamiento antes de filtrar las filas fuera de la ventana', async () => {
    const outside = { ...rows[0], fechaMovimiento: '2026-10-19T09:00:00-03:00' };
    const client = { consultarMovimientosDetallados: jest.fn().mockResolvedValue({ movements: Array(10).fill(outside), verified: false }) };
    const result = await new AtlasFeedSource(client as any, { ...config, maxRows: 10 }).fetch({ from, to, includeReversed: true });
    expect(result.truncated).toBe(true);
    expect(result.movements).toHaveLength(0);
  });
});
