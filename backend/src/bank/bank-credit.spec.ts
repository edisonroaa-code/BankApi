import { AtlasContractError, parseMovementsResponse } from './atlas/atlas-movements';
import { MANUAL_MOVIMIENTOS_DETALLE } from './atlas/atlas.fixtures';
import { maskIdentifier, normalizeReference, toNormalizedCredit } from './bank-credit';
import { formatWithOffset, isWithinHours, localDateKey, readBankFeedConfig, readBankFeedConfigSafe, startOfLocalDay } from './bank-feed.config';
import { BankTransferSource } from './entities/bank-transfer.entity';

const manualMovement = (patch: Record<string, unknown> = {}, infoPatch: Record<string, unknown> = {}) => {
  const base = MANUAL_MOVIMIENTOS_DETALLE.listaMovimiento[0];
  return parseMovementsResponse({ listaMovimiento: [{ ...base, ...patch, infoAdicional: { ...base.infoAdicional, ...infoPatch } }] })[0];
};

describe('Credito bancario normalizado', () => {
  it('toma del manual los datos que usa el panel', () => {
    const credit = toNormalizedCredit(manualMovement(), BankTransferSource.ATLAS);
    expect(credit).toMatchObject({
      accountNumber: '123456',
      bankDocNumber: '106188',
      bancardTxId: null,
      amount: 20000,
      currency: 'PYG',
      senderName: 'USUARIO DE PRUEBA',
      senderDoc: '987654-3',
      senderAccount: '111666',
      senderNote: 'ayuda',
      txCode: '602',
      processDate: '2023-06-10',
      reversed: false,
    });
    expect(credit.movementAt.toISOString()).toBe('2020-12-24T10:44:08.000Z');
  });

  it('la huella no cambia cuando el banco marca la reversa ni cuando cambia la fecha de proceso', () => {
    const original = toNormalizedCredit(manualMovement(), BankTransferSource.ATLAS);
    const reversed = toNormalizedCredit(manualMovement({ 'fecha Proceso': '2023-06-11' }, { reversado: 'S', estado: 'R' }), BankTransferSource.ATLAS);
    expect(reversed.reversed).toBe(true);
    expect(reversed.fingerprint).toBe(original.fingerprint);
  });

  it('la huella distingue otro documento o monto', () => {
    const original = toNormalizedCredit(manualMovement(), BankTransferSource.ATLAS);
    expect(toNormalizedCredit(manualMovement({ nroDocumento: 106189 }), BankTransferSource.ATLAS).fingerprint).not.toBe(original.fingerprint);
    expect(toNormalizedCredit(manualMovement({ monto: 20001 }), BankTransferSource.ATLAS).fingerprint).not.toBe(original.fingerprint);
  });

  it('una moneda fuera del formato del banco es error de contrato, no se adivina', () => {
    // Como el laboratorio: ISO de tres mayusculas y coherente con el codigo (6900 = PYG).
    const base = MANUAL_MOVIMIENTOS_DETALLE.listaMovimiento[0];
    const withMoneda = (moneda: unknown) => () => parseMovementsResponse({ listaMovimiento: [{ ...base, moneda }] });
    expect(withMoneda({ ...base.moneda, iso: ' pyg ' })).toThrow(AtlasContractError);
    expect(withMoneda({ ...base.moneda, iso: 'USD' })).toThrow(/moneda.iso/);
    expect(withMoneda({ iso: 'PYG' })).toThrow(/moneda.codigo/);
  });

  it('la huella no cambia si el codigo de transaccion llega como numero o como texto', () => {
    // El banco empezo a mandar cod_transaccion como "602.0" (2026-10-07); el manual dice Integer.
    const asNumber = toNormalizedCredit(manualMovement({}, { cod_transaccion: 602.0, cod_tra_padre: 388.0 }), BankTransferSource.ATLAS);
    const asText = toNormalizedCredit(manualMovement({}, { cod_transaccion: '602.0', cod_tra_padre: '388.0' }), BankTransferSource.ATLAS);
    const asPlainText = toNormalizedCredit(manualMovement({}, { cod_transaccion: ' 602 ' }), BankTransferSource.ATLAS);
    expect(asText.txCode).toBe('602');
    expect(asText.fingerprint).toBe(asNumber.fingerprint);
    expect(asPlainText.fingerprint).toBe(asNumber.fingerprint);
  });

  it('enmascara documentos y cuentas para cajeros', () => {
    expect(maskIdentifier('987654-3')).toBe('98****-3');
    expect(maskIdentifier('111666')).toBe('11***66');
    expect(maskIdentifier(null)).toBeNull();
  });

  it('normaliza el numero de ticket para que no se pueda pagar dos veces escribiendolo distinto', () => {
    expect(normalizeReference(' 0045 ')).toBe('45');
    expect(normalizeReference('45')).toBe('45');
    expect(normalizeReference('cl 12a')).toBe('CL12A');
    expect(normalizeReference('000')).toBe('0');
  });
});

describe('Configuracion y horario del feed', () => {
  const config = readBankFeedConfig((k) => ({ BANK_FEED_MODE: 'mock', BANK_FEED_HOURS: '07:00-20:00' } as Record<string, string>)[k]);

  it('usa la hora de Paraguay para el horario operativo', () => {
    expect(isWithinHours(config, new Date('2026-09-19T10:00:00Z'))).toBe(true); // 07:00 local
    expect(isWithinHours(config, new Date('2026-09-19T09:59:00Z'))).toBe(false); // 06:59 local
    expect(isWithinHours(config, new Date('2026-09-19T23:00:00Z'))).toBe(false); // 20:00 local
  });

  it('calcula el inicio del dia y el formato de fechas del banco', () => {
    const at = new Date('2026-09-20T02:30:00Z'); // 23:30 del 19 en Paraguay
    expect(localDateKey(at, -180)).toBe('2026-09-19');
    expect(startOfLocalDay(at, -180).toISOString()).toBe('2026-09-19T03:00:00.000Z');
    expect(formatWithOffset(at, '-03:00', -180)).toBe('2026-09-19T23:30:00-03:00');
  });

  it('prohibe el modo simulado en produccion', () => {
    expect(() => readBankFeedConfig((k) => ({ BANK_FEED_MODE: 'mock', NODE_ENV: 'production' } as Record<string, string>)[k])).toThrow(/mock/);
  });

  it('un error de configuracion apaga el feed sin tumbar la API', () => {
    const safe = readBankFeedConfigSafe((k) => ({ BANK_FEED_MODE: 'mock', NODE_ENV: 'production' } as Record<string, string>)[k]);
    expect(safe.mode).toBe('off');
    expect(safe.configError).toMatch(/mock/);
    const badHours = readBankFeedConfigSafe((k) => ({ BANK_FEED_MODE: 'atlas', BANK_FEED_ACCOUNT: '1', BANK_FEED_HOURS: '7-20' } as Record<string, string>)[k]);
    expect(badHours).toMatchObject({ mode: 'off', configError: expect.stringContaining('BANK_FEED_HOURS') });
  });
});
