import { KeyObject } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { AtlasBalance, parseBalanceResponse } from './atlas-balance';
import { buildAtlasClaims, loadPublicKey, loadRsaPrivateKey, signRs256, verifyAtlasResponse } from './atlas-jwt';
import { AtlasMovement, parseMovementsResponse } from './atlas-movements';
import { BankEntity, parseEntitiesResponse, parseSipapOperationsResponse, SipapOperation } from './atlas-sipap';

export const AUD_CUENTAS = 'cuentas-atlas';
export const AUD_TRANSFERENCIAS = 'transferencias-atlas';
export const AUD_DATOS_GENERALES = 'datos-generales-atlas';

/** Codigos del banco que indican credenciales o permisos invalidos: reintentar no sirve. */
const AUTH_ERROR_CODES = new Set(['cm1061', 'cm1052', 'g1001', 'g1011']);

export class AtlasApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly bankCode?: string,
  ) {
    super(message);
  }

  get isAuthError() {
    return this.status === 401 || this.status === 403 || (!!this.bankCode && AUTH_ERROR_CODES.has(this.bankCode));
  }
}

export type AtlasConfig = {
  baseUrl: string;
  /** Grupo transferencias-atlas (Consulta de Operaciones SIPAP). Opcional: solo para el banco de origen. */
  transferenciasBaseUrl?: string;
  /** Grupo datos-generales-atlas (catalogo de entidades participantes). */
  datosGeneralesBaseUrl?: string;
  apiKey: string;
  accountAuthToken: string;
  privateKeyPem: string;
  jwtIss: string;
  jwtSub: string;
  jwtUser?: string;
  jwtExpSeconds: number;
  timeoutMs: number;
  bankPublicKeyPem?: string;
  verifyResponse: boolean;
};

/** Clave desde la variable PEM (Render) o desde un archivo local (desarrollo, como el laboratorio). */
const readKey = (env: (key: string) => string | undefined, pemKey: string, pathKey: string) => {
  const pem = env(pemKey);
  if (pem?.trim()) return pem;
  const path = env(pathKey)?.trim();
  return path && existsSync(path) ? readFileSync(path, 'utf8') : undefined;
};

/** Lee la configuracion Atlas del entorno. Devuelve la lista de variables faltantes si no alcanza. */
export const readAtlasConfig = (env: (key: string) => string | undefined): { config?: AtlasConfig; missing: string[] } => {
  const privateKeyPem = readKey(env, 'ATLAS_PRIVATE_KEY_PEM', 'ATLAS_PRIVATE_KEY_PATH');
  const requiredKeys = ['ATLAS_BASE_URL', 'ATLAS_API_KEY', 'ATLAS_ACCOUNT_AUTH_TOKEN', 'ATLAS_JWT_ISS', 'ATLAS_JWT_SUB'];
  const missing = requiredKeys.filter((key) => !env(key)?.trim());
  if (!privateKeyPem) missing.push('ATLAS_PRIVATE_KEY_PEM (o ATLAS_PRIVATE_KEY_PATH)');
  if (missing.length > 0) return { missing };
  return {
    missing,
    config: {
      baseUrl: env('ATLAS_BASE_URL')!.trim().replace(/\/+$/, ''),
      transferenciasBaseUrl: env('ATLAS_TRANSFERENCIAS_BASE_URL')?.trim().replace(/\/+$/, '') || undefined,
      datosGeneralesBaseUrl: env('ATLAS_DATOS_GENERALES_BASE_URL')?.trim().replace(/\/+$/, '') || undefined,
      apiKey: env('ATLAS_API_KEY')!.trim(),
      accountAuthToken: env('ATLAS_ACCOUNT_AUTH_TOKEN')!.trim(),
      privateKeyPem: privateKeyPem!,
      jwtIss: env('ATLAS_JWT_ISS')!.trim(),
      jwtSub: env('ATLAS_JWT_SUB')!.trim(),
      jwtUser: env('ATLAS_JWT_USER')?.trim() || undefined,
      jwtExpSeconds: Number(env('ATLAS_JWT_EXP_SECONDS')) || 50,
      timeoutMs: (Number(env('ATLAS_TIMEOUT_SECONDS')) || 30) * 1000,
      bankPublicKeyPem: readKey(env, 'ATLAS_BANK_PUBLIC_KEY_PEM', 'ATLAS_BANK_PUBLIC_KEY_PATH'),
      // Falla cerrada, como el laboratorio: solo se apaga con un `false` explicito (sandbox o
      // preproduccion), nunca por olvidar la variable.
      verifyResponse: (env('ATLAS_VERIFY_RESPONSE')?.trim().toLowerCase() ?? 'true') !== 'false',
    },
  };
};

/** `X-Atl-Timestamp`: UTC con segundos y `+00:00`, igual que el laboratorio y los ejemplos del banco. */
export const atlasTimestamp = (now = new Date()) => now.toISOString().replace(/\.\d{3}Z$/, '+00:00');

/**
 * Cliente de solo lectura de Atlas Connect: movimientos detallados de la cuenta, consulta de
 * operaciones SIPAP y catalogo de entidades. Nunca registra transferencias (no mueve dinero).
 * Copia del laboratorio (D:\APLICATIVOS\conexion a api...), que sigue siendo la referencia:
 * los ajustes que se hagan alli deben replicarse aqui.
 */
export class AtlasClient {
  private readonly privateKey: KeyObject;
  private readonly bankPublicKey: KeyObject | null;

  constructor(
    private readonly config: AtlasConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.privateKey = loadRsaPrivateKey(config.privateKeyPem);
    this.bankPublicKey = config.bankPublicKeyPem ? loadPublicKey(config.bankPublicKeyPem) : null;
    if (config.verifyResponse && !this.bankPublicKey) {
      throw new Error('ATLAS_VERIFY_RESPONSE=true exige ATLAS_BANK_PUBLIC_KEY_PEM.');
    }
  }

  /**
   * Rechazo del banco. Puede llegar sin firma (rechazos de gateway): se conserva el estado HTTP y
   * el codigo para diagnosticar y para detectar credenciales invalidas, pero el texto del banco
   * solo se muestra si la respuesta fue verificada y el banco marco `useApiMessage`.
   * Port de `_error_from_response` del laboratorio.
   */
  private errorFromResponse(status: number, data: unknown, trusted: boolean): AtlasApiError {
    const err = (data && typeof data === 'object' && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
    const code = typeof err.code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(err.code) ? err.code : undefined;
    const publicStatus = status >= 400 && status < 600 ? status : 502;
    const message =
      trusted && err.useApiMessage === true && typeof err.message === 'string' && err.message.trim()
        ? err.message.slice(0, 500)
        : `Banco Atlas rechazo la solicitud (HTTP ${status}${code ? `, codigo ${code}` : ''}).`;
    return new AtlasApiError(publicStatus, message, code);
  }

  /** GET firmado: JWT RS256 con los claims 2026, verificacion de respuesta y errores del banco. */
  private async signedGet(baseUrl: string, resource: string, aud: string, query: URLSearchParams, timeoutMs = this.config.timeoutMs) {
    const timestamp = atlasTimestamp();
    const claims = buildAtlasClaims({
      timestamp,
      resource,
      accountAuthToken: this.config.accountAuthToken,
      aud,
      iss: this.config.jwtIss,
      sub: this.config.jwtSub,
      user: this.config.jwtUser,
      expSeconds: this.config.jwtExpSeconds,
    });
    const token = signRs256(claims, this.privateKey);

    const qs = query.toString();
    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}${resource}${qs ? `?${qs}` : ''}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-RshkMichi-ApiKey': this.config.apiKey,
          'X-Atl-Timestamp': timestamp,
          'X-Atl-Auth': token,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error: any) {
      throw new AtlasApiError(502, `No se pudo conectar con Banco Atlas (${error?.name || 'error de red'}).`);
    }

    const body = Buffer.from(await response.arrayBuffer());
    const responseToken = response.headers.get('X-Atl-Auth');
    const parseBody = (): unknown => {
      try {
        return JSON.parse(body.toString('utf8'));
      } catch {
        return undefined;
      }
    };

    if (response.status < 200 || response.status >= 300) {
      // Un rechazo sin firma no se convierte en error de integridad: se perderia el 401/codigo
      // que detiene el feed ante credenciales invalidas. Si viene firmado, se verifica igual.
      const trusted = responseToken
        ? verifyAtlasResponse({
            token: responseToken,
            body,
            aud,
            bankPublicKey: this.bankPublicKey,
            required: this.config.verifyResponse,
            expectedClaims: claims,
          }).verified
        : false;
      throw this.errorFromResponse(response.status, parseBody(), trusted);
    }

    // Una respuesta exitosa solo se procesa autenticada y ligada a esta solicitud (si es obligatorio).
    const integrity = verifyAtlasResponse({
      token: responseToken,
      body,
      aud,
      bankPublicKey: this.bankPublicKey,
      required: this.config.verifyResponse,
      expectedClaims: claims,
    });

    const data = parseBody();
    if (data === undefined) throw new AtlasApiError(502, `Banco Atlas respondio un cuerpo ilegible (HTTP ${response.status}).`);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new AtlasApiError(502, 'Banco Atlas respondio con un formato inesperado.');
    }
    return { data, verified: integrity.verified };
  }

  async consultarMovimientosDetallados(params: {
    numeroCuenta: string;
    fecInicio: string;
    fecFin: string;
    tipoMovimiento?: 'C' | 'D';
    cantidad?: number;
    incluyeReversa?: boolean;
    orden?: 'ASC' | 'DESC';
  }): Promise<{ movements: AtlasMovement[]; verified: boolean }> {
    if (!/^\d{1,30}$/.test(params.numeroCuenta)) throw new AtlasApiError(400, 'Numero de cuenta invalido.');

    // `resource` va sin query string y sin version, como en los JWT de ejemplo del banco.
    const resource = `/cuentas/${params.numeroCuenta}/movimientos-detalle`;
    const query = new URLSearchParams({ fecInicio: params.fecInicio, fecFin: params.fecFin });
    if (params.tipoMovimiento) query.set('tipoMovimiento', params.tipoMovimiento);
    if (params.cantidad) query.set('cantidad', String(params.cantidad));
    if (params.incluyeReversa !== undefined) query.set('incluyeReversa', params.incluyeReversa ? 'true' : 'false');
    if (params.orden) query.set('orden', params.orden);

    const { data, verified } = await this.signedGet(this.config.baseUrl, resource, AUD_CUENTAS, query);
    return { movements: parseMovementsResponse(data, params.numeroCuenta), verified };
  }

  /** Consulta de Saldo v0.9. Solo para el admin, a pedido: el panel en vivo nunca la usa. */
  async consultarSaldo(numeroCuenta: string): Promise<{ balance: AtlasBalance; verified: boolean }> {
    if (!/^\d{1,30}$/.test(numeroCuenta)) throw new AtlasApiError(400, 'Numero de cuenta invalido.');
    const { data, verified } = await this.signedGet(this.config.baseUrl, `/cuentas/${numeroCuenta}/saldo`, AUD_CUENTAS, new URLSearchParams());
    return { balance: parseBalanceResponse(data, numeroCuenta), verified };
  }

  /** Consulta de Operaciones SIPAP (Transferencias v1.4). Puede tardar mas de 20 s en el banco. */
  async consultarOperacionesSipap(params: { fechaDesde: string; fechaHasta: string; codSwiBeneficiario?: string }, timeoutMs = 60_000): Promise<SipapOperation[]> {
    if (!this.config.transferenciasBaseUrl) throw new AtlasApiError(400, 'Falta ATLAS_TRANSFERENCIAS_BASE_URL.');
    const query = new URLSearchParams({ fechaDesde: params.fechaDesde, fechaHasta: params.fechaHasta });
    if (params.codSwiBeneficiario) query.set('codSwiBeneficiario', params.codSwiBeneficiario);
    const { data } = await this.signedGet(this.config.transferenciasBaseUrl, '/sipap/consultar-operaciones', AUD_TRANSFERENCIAS, query, timeoutMs);
    return parseSipapOperationsResponse(data);
  }

  /** Catalogo de entidades participantes: codigo SWIFT -> nombre del banco. */
  async consultarEntidadesParticipantes(): Promise<BankEntity[]> {
    if (!this.config.datosGeneralesBaseUrl) throw new AtlasApiError(400, 'Falta ATLAS_DATOS_GENERALES_BASE_URL.');
    const { data } = await this.signedGet(this.config.datosGeneralesBaseUrl, '/bancos_participante', AUD_DATOS_GENERALES, new URLSearchParams());
    return parseEntitiesResponse(data);
  }
}
