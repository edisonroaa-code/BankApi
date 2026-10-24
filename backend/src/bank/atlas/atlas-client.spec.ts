import { createHash, generateKeyPairSync, KeyObject } from 'crypto';
import { AtlasApiError, AtlasClient, atlasTimestamp, readAtlasConfig } from './atlas-client';
import { AtlasIntegrityError, decodeJwt, loadRsaPrivateKey, signRs256, verifyAtlasResponse } from './atlas-jwt';
import { parseBalanceResponse } from './atlas-balance';
import { AtlasContractError, parseMovementsResponse } from './atlas-movements';
import { MANUAL_MOVIMIENTOS_DETALLE } from './atlas.fixtures';

const pem = (key: KeyObject, type: 'pkcs8' | 'spki') => key.export({ type, format: 'pem' }).toString();

describe('Cliente Atlas (copia de solo lectura del laboratorio)', () => {
  let appKeys: { privateKey: KeyObject; publicKey: KeyObject };
  let bankKeys: { privateKey: KeyObject; publicKey: KeyObject };

  beforeAll(() => {
    appKeys = generateKeyPairSync('rsa', { modulusLength: 4096 });
    bankKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  });

  const makeClient = (fetchImpl: any, overrides: Record<string, string> = {}) => {
    const env: Record<string, string> = {
      ATLAS_BASE_URL: 'https://banco.example/desa03/cuentas-atlas/',
      ATLAS_API_KEY: 'api-key-prueba',
      ATLAS_ACCOUNT_AUTH_TOKEN: 'token-cuenta-prueba',
      ATLAS_PRIVATE_KEY_PEM: pem(appKeys.privateKey, 'pkcs8'),
      ATLAS_JWT_ISS: 'BANKAPI_APP',
      ATLAS_JWT_SUB: 'BANKAPI_APP',
      // Perfil sandbox: el banco responde sin firma. La verificacion se prueba aparte.
      ATLAS_VERIFY_RESPONSE: 'false',
      ...overrides,
    };
    const { config } = readAtlasConfig((k) => env[k]);
    return new AtlasClient(config!, fetchImpl);
  };

  const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  it('informa las variables faltantes en lugar de arrancar a medias', () => {
    const { config, missing } = readAtlasConfig(() => undefined);
    expect(config).toBeUndefined();
    expect(missing).toEqual(expect.arrayContaining(['ATLAS_API_KEY', 'ATLAS_PRIVATE_KEY_PEM (o ATLAS_PRIVATE_KEY_PATH)']));
  });

  it('exige clave RSA de 4096 bits (politica 2026)', () => {
    const small = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => loadRsaPrivateKey(pem(small.privateKey, 'pkcs8'))).toThrow(/4096/);
  });

  it('firma la consulta de movimientos con las cabeceras y claims que exige el banco', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, MANUAL_MOVIMIENTOS_DETALLE));
    const client = makeClient(fetchImpl);

    const { movements, verified } = await client.consultarMovimientosDetallados({
      numeroCuenta: '123456',
      fecInicio: '2026-09-19T00:00:00-03:00',
      fecFin: '2026-09-19T10:00:00-03:00',
      tipoMovimiento: 'C',
      cantidad: 200,
      incluyeReversa: true,
      orden: 'DESC',
    });

    const [url, init] = fetchImpl.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://banco.example/desa03/cuentas-atlas/cuentas/123456/movimientos-detalle');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      fecInicio: '2026-09-19T00:00:00-03:00',
      fecFin: '2026-09-19T10:00:00-03:00',
      tipoMovimiento: 'C',
      cantidad: '200',
      incluyeReversa: 'true',
      orden: 'DESC',
    });
    expect(init.headers['X-RshkMichi-ApiKey']).toBe('api-key-prueba');
    expect(init.headers['X-Atl-Timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);

    const token = decodeJwt(init.headers['X-Atl-Auth']);
    expect(token.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(token.payload).toMatchObject({
      time: init.headers['X-Atl-Timestamp'],
      resource: '/cuentas/123456/movimientos-detalle',
      auth: 'token-cuenta-prueba',
      'content-hash': '',
      iss: 'BANKAPI_APP',
      sub: 'BANKAPI_APP',
      aud: 'cuentas-atlas',
    });
    expect(Number(token.payload.exp) - Number(token.payload.iat)).toBe(50);
    expect(typeof token.payload.jti).toBe('string');

    expect(verified).toBe(false);
    expect(movements[0]).toMatchObject({ monto: 20000, moneda: 'PYG', tipoMovimiento: 'CREDITO', nroDocumento: '106188', fechaProceso: '2023-06-10' });
  });

  it('un rechazo sin firma conserva estado y codigo, pero no muestra el texto del banco', async () => {
    const client = makeClient(
      jest.fn().mockResolvedValue(jsonResponse(400, { code: 'g1001', message: 'Texto no autenticado <script>', type: 'APPLICATION', useApiMessage: true })),
    );
    const error = await client
      .consultarMovimientosDetallados({ numeroCuenta: '1870227', fecInicio: 'a', fecFin: 'b' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(AtlasApiError);
    expect(error.status).toBe(400);
    expect(error.bankCode).toBe('g1001');
    expect(error.message).toBe('Banco Atlas rechazo la solicitud (HTTP 400, codigo g1001).');
    expect(error.isAuthError).toBe(true);
  });

  it('con verificacion obligatoria, un 401 sin firma sigue siendo error de credenciales (detiene el feed)', async () => {
    const client = makeClient(jest.fn().mockResolvedValue(jsonResponse(401, { code: 'cm1061' })), {
      ATLAS_VERIFY_RESPONSE: 'true',
      ATLAS_BANK_PUBLIC_KEY_PEM: pem(bankKeys.publicKey, 'spki'),
    });
    const error = await client.consultarMovimientosDetallados({ numeroCuenta: '1870227', fecInicio: 'a', fecFin: 'b' }).catch((e) => e);
    expect(error).toBeInstanceOf(AtlasApiError);
    expect(error.isAuthError).toBe(true);
  });

  it('la verificacion de firma es obligatoria por defecto: sin clave publica del banco no arranca', () => {
    const env: Record<string, string> = {
      ATLAS_BASE_URL: 'https://banco.example/x',
      ATLAS_API_KEY: 'k',
      ATLAS_ACCOUNT_AUTH_TOKEN: 't',
      ATLAS_PRIVATE_KEY_PEM: pem(appKeys.privateKey, 'pkcs8'),
      ATLAS_JWT_ISS: 'i',
      ATLAS_JWT_SUB: 's',
    };
    const { config } = readAtlasConfig((k) => env[k]);
    expect(config!.verifyResponse).toBe(true);
    expect(() => new AtlasClient(config!)).toThrow(/ATLAS_BANK_PUBLIC_KEY_PEM/);
  });

  describe('respuesta firmada y ligada a la solicitud', () => {
    // Banco simulado que hace lo que dice el manual: devuelve los mismos claims que recibio,
    // con el content-hash del cuerpo, firmado con su clave.
    const signedBank = (status: number, payload: unknown, tamper: (claims: Record<string, unknown>) => void = () => undefined) =>
      jest.fn(async (_url: string, init: any) => {
        const body = Buffer.from(JSON.stringify(payload));
        const claims: Record<string, unknown> = { ...decodeJwt(init.headers['X-Atl-Auth']).payload };
        claims['content-hash'] = createHash('sha256').update(body).digest('hex');
        tamper(claims);
        return new Response(body, { status, headers: { 'Content-Type': 'application/json', 'X-Atl-Auth': signRs256(claims, bankKeys.privateKey) } });
      });
    const withKey = () => ({ ATLAS_VERIFY_RESPONSE: 'true', ATLAS_BANK_PUBLIC_KEY_PEM: pem(bankKeys.publicKey, 'spki') });
    const query = { numeroCuenta: '123456', fecInicio: 'a', fecFin: 'b' };

    it('acepta la respuesta que repite los claims de la consulta', async () => {
      const client = makeClient(signedBank(200, MANUAL_MOVIMIENTOS_DETALLE), withKey());
      const { verified, movements } = await client.consultarMovimientosDetallados(query);
      expect(verified).toBe(true);
      expect(movements).toHaveLength(1);
    });

    it('rechaza una respuesta firmada de otra consulta (claim distinto)', async () => {
      const client = makeClient(signedBank(200, MANUAL_MOVIMIENTOS_DETALLE, (c) => (c.resource = '/cuentas/999/movimientos-detalle')), withKey());
      await expect(client.consultarMovimientosDetallados(query)).rejects.toThrow(/claim resource/);
    });

    it('rechaza una respuesta reutilizada (jti de otra solicitud)', async () => {
      const client = makeClient(signedBank(200, MANUAL_MOVIMIENTOS_DETALLE, (c) => (c.jti = 'otro-jti')), withKey());
      await expect(client.consultarMovimientosDetallados(query)).rejects.toThrow(/claim jti/);
    });

    it('exige content-hash: una firma sin hash no protege el cuerpo', async () => {
      const client = makeClient(signedBank(200, MANUAL_MOVIMIENTOS_DETALLE, (c) => delete c['content-hash']), withKey());
      await expect(client.consultarMovimientosDetallados(query)).rejects.toThrow(/content-hash/);
    });

    it('un rechazo firmado con useApiMessage si puede mostrar el texto del banco', async () => {
      const client = makeClient(signedBank(400, { code: 'g1040', message: 'Rango de fechas invalido.', useApiMessage: true }), withKey());
      const error = await client.consultarMovimientosDetallados(query).catch((e) => e);
      expect(error.message).toBe('Rango de fechas invalido.');
      expect(error.status).toBe(400);
    });
  });

  describe('saldo (solo admin, a pedido)', () => {
    const saldo = {
      nroCuenta: '123456',
      producto: { codigo: 1, descripcion: 'CUENTA CORRIENTE', descripcionCorta: 'CC' },
      moneda: 'PYG',
      saldo: 1500000,
      saldoDisponible: 1400000,
      depositoConfirmar: null,
      saldoBloqueado: 100000,
      saldoProtegido: null,
      saldoPromedio: null,
      infoAdicional: { dias_mora: 0, monto_mov_pendientes: 0 },
    };

    it('lee el saldo con el mismo GET firmado y deja en null lo que el banco no informa', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, saldo));
      const { balance } = await makeClient(fetchImpl).consultarSaldo('123456');
      expect(new URL(fetchImpl.mock.calls[0][0]).pathname).toBe('/desa03/cuentas-atlas/cuentas/123456/saldo');
      expect(balance).toMatchObject({ saldo: 1500000, saldoDisponible: 1400000, saldoBloqueado: 100000, depositoConfirmar: null, moneda: 'PYG' });
    });

    it('rechaza el saldo de otra cuenta o con importes que no son numeros', () => {
      expect(() => parseBalanceResponse(saldo, '999')).toThrow(/nroCuenta/);
      expect(() => parseBalanceResponse({ ...saldo, saldo: '1500000' }, '123456')).toThrow(/saldo/);
      expect(() => parseBalanceResponse({ ...saldo, saldoDisponible: null }, '123456')).toThrow(/saldoDisponible/);
    });
  });

  describe('contrato estricto de movimientos (port del laboratorio)', () => {
    const base = MANUAL_MOVIMIENTOS_DETALLE.listaMovimiento[0];
    const parse = (patch: Record<string, unknown>, info: Record<string, unknown> = {}, account = '123456') => () =>
      parseMovementsResponse({ listaMovimiento: [{ ...base, ...patch, infoAdicional: { ...base.infoAdicional, ...info } }] }, account);

    it('acepta los codigos de auditoria como texto entero, como manda hoy el banco', () => {
      expect(parse({}, { cod_transaccion: '602.0', cod_tra_padre: ' 388 ' })).not.toThrow();
    });

    it('rechaza codigos de auditoria que no son enteros', () => {
      for (const bad of [true, 602.5, '602.5', '6e2', 'abc', [602], { v: 602 }, Number.NaN]) {
        expect(parse({}, { cod_transaccion: bad })).toThrow(AtlasContractError);
      }
    });

    it('nunca convierte texto en dinero ni acepta un movimiento de otra cuenta', () => {
      expect(parse({ monto: '20000' })).toThrow(/monto/);
      expect(parse({ monto: true })).toThrow(/monto/);
      expect(parse({}, {}, '999999')).toThrow(/numeroCuenta/);
    });

    it('valida tipo, fechas reales y que los dos nombres de la fecha de proceso no se contradigan', () => {
      expect(parse({ tipoMovimiento: 'TRANSFERENCIA' })).toThrow(/tipoMovimiento/);
      expect(parse({ fechaMovimiento: '2026-02-30T10:00:00-03:00' })).toThrow(/fechaMovimiento/);
      expect(parse({ fechaMovimiento: '24/12/2020' })).toThrow(/fechaMovimiento/);
      expect(parse({ fechaProceso: '2023-06-11' })).toThrow(/fechaProceso/);
      expect(parse({ fechaProceso: '2023-06-10' })).not.toThrow();
    });

    it('metadata con otra forma es error, no un objeto vacio silencioso', () => {
      expect(() => parseMovementsResponse({ listaMovimiento: [{ ...base, infoAdicional: 'x' }] })).toThrow(/infoAdicional/);
      expect(parse({}, { reversado: 'X' })).toThrow(/reversado/);
      expect(() => parseMovementsResponse({ listaMovimiento: [{ ...base, infoAdicional: null }] })).not.toThrow();
    });
  });

  it('un campo obligatorio ausente es error de contrato, nunca una fila inventada', () => {
    const broken = { listaMovimiento: [{ ...MANUAL_MOVIMIENTOS_DETALLE.listaMovimiento[0], monto: undefined }] };
    expect(() => parseMovementsResponse(broken)).toThrow(AtlasContractError);
    expect(() => parseMovementsResponse({})).toThrow(/listaMovimiento/);
  });

  describe('verificacion de la respuesta del banco', () => {
    const body = Buffer.from(JSON.stringify(MANUAL_MOVIMIENTOS_DETALLE));
    const bankToken = (claims: object) => signRs256(claims, bankKeys.privateKey);
    const hash = createHash('sha256').update(body).digest('hex');
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`;

    it('acepta una respuesta firmada por el banco con el hash del cuerpo', () => {
      const token = bankToken({ aud: 'cuentas-atlas', 'content-hash': hash, exp: Math.floor(Date.now() / 1000) + 60 });
      expect(verifyAtlasResponse({ token, body, aud: 'cuentas-atlas', bankPublicKey: bankKeys.publicKey, required: true })).toEqual({ verified: true });
    });

    it('rechaza un cuerpo alterado, otra audiencia y una firma ajena', () => {
      const good = { aud: 'cuentas-atlas', 'content-hash': hash, exp: Math.floor(Date.now() / 1000) + 60 };
      const check = (token: string, b = body) =>
        verifyAtlasResponse({ token, body: b, aud: 'cuentas-atlas', bankPublicKey: bankKeys.publicKey, required: false });
      expect(() => check(bankToken(good), Buffer.from('{"listaMovimiento":[]}'))).toThrow(AtlasIntegrityError);
      expect(() => check(bankToken({ ...good, aud: 'transferencias-atlas' }))).toThrow(/Audiencia/);
      expect(() => check(signRs256(good, appKeys.privateKey))).toThrow(/Firma/);
    });

    it('un JWT alg:none (como el del sandbox) no autentica: se rechaza si la verificacion es obligatoria', () => {
      expect(() => verifyAtlasResponse({ token: unsigned, body, aud: 'cuentas-atlas', bankPublicKey: bankKeys.publicKey, required: true })).toThrow(/alg: none/);
      expect(verifyAtlasResponse({ token: unsigned, body, aud: 'cuentas-atlas', bankPublicKey: bankKeys.publicKey, required: false })).toEqual({
        verified: false,
        reason: expect.stringContaining('alg: none'),
      });
    });
  });

  it('formatea X-Atl-Timestamp en UTC sin milisegundos', () => {
    expect(atlasTimestamp(new Date('2026-09-19T12:34:56.789Z'))).toBe('2026-09-19T12:34:56+00:00');
  });
});
