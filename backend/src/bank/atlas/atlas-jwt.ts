import { createHash, createPrivateKey, createPublicKey, KeyObject, randomUUID, sign, timingSafeEqual, verify } from 'crypto';

/**
 * JWT RS256 de Atlas Connect implementado con `crypto` de Node (sin dependencias nuevas).
 * Replica `_jwt_for_resource` y `_verify_response_integrity` de api_atlas.py (laboratorio D:).
 */

const base64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

export const sha256Hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

export const loadRsaPrivateKey = (pem: string, minBits = 4096): KeyObject => {
  const key = createPrivateKey(pem.replace(/\\n/g, '\n'));
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(`Se requiere una clave privada RSA; se recibio ${key.asymmetricKeyType}.`);
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < minBits) {
    throw new Error(`La clave RSA tiene ${bits} bits; Atlas exige al menos ${minBits} (politica 2026).`);
  }
  return key;
};

export const loadPublicKey = (pem: string): KeyObject => createPublicKey(pem.replace(/\\n/g, '\n'));

export type AtlasJwtClaims = {
  time: string;
  resource: string;
  auth: string;
  'content-hash': string;
  exp: number;
  jti: string;
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  user?: string;
};

export const buildAtlasClaims = (opts: {
  timestamp: string;
  resource: string;
  accountAuthToken: string;
  aud: string;
  iss: string;
  sub: string;
  expSeconds: number;
  user?: string;
  contentHash?: string;
  now?: Date;
}): AtlasJwtClaims => {
  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const claims: AtlasJwtClaims = {
    time: opts.timestamp,
    resource: opts.resource,
    auth: opts.accountAuthToken,
    // Siempre presente: vacio en GET, SHA256 del cuerpo en POST (como los ejemplos del banco).
    'content-hash': opts.contentHash ?? '',
    exp: nowSeconds + opts.expSeconds,
    jti: randomUUID(),
    iss: opts.iss,
    sub: opts.sub,
    aud: opts.aud,
    iat: nowSeconds,
  };
  if (opts.user) claims.user = opts.user;
  return claims;
};

export const signRs256 = (claims: object, privateKey: KeyObject): string => {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(claims));
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
};

export type DecodedJwt = { header: Record<string, unknown>; payload: Record<string, unknown>; signingInput: string; signature: Buffer };

export const decodeJwt = (token: string): DecodedJwt => {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('JWT con formato invalido.');
  const [h, p, s] = parts;
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')),
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s, 'base64url'),
  };
};

export class AtlasIntegrityError extends Error {
  readonly code = 'ATLAS_INTEGRITY_ERROR';
}

/** Comparacion en tiempo constante para textos; igualdad estricta para el resto. */
const sameClaim = (actual: unknown, expected: unknown) => {
  if (typeof actual === 'string' && typeof expected === 'string') {
    const a = Buffer.from(actual);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  return actual === expected;
};

/**
 * Verifica la cabecera X-Atl-Auth de la respuesta del banco. Un JWT `alg: none` no esta
 * firmado: con verificacion obligatoria se rechaza; sin ella se informa como no autenticado.
 * Devuelve `verified` para que el feed pueda exponer si los datos quedaron autenticados.
 *
 * `expectedClaims` son los claims del JWT que mandamos: los manuales dicen que el banco los
 * devuelve iguales y solo cambia `content-hash` y la firma. Compararlos liga la respuesta a
 * esta solicitud concreta, asi una respuesta firmada de otra consulta no puede reutilizarse.
 * Una firma presente pero invalida se rechaza siempre: eso es manipulacion, no falta de firma.
 */
export const verifyAtlasResponse = (opts: {
  token: string | null;
  body: Buffer;
  aud: string;
  bankPublicKey: KeyObject | null;
  required: boolean;
  expectedClaims?: Record<string, unknown>;
  nowSeconds?: number;
}): { verified: boolean; reason?: string } => {
  const fail = (reason: string) => {
    if (opts.required) throw new AtlasIntegrityError(`Integridad de respuesta de Atlas no verificada: ${reason}`);
    return { verified: false, reason };
  };

  if (!opts.bankPublicKey) return fail('clave publica del banco no configurada');
  if (!opts.token) return fail('cabecera X-Atl-Auth ausente');

  let decoded: DecodedJwt;
  try {
    decoded = decodeJwt(opts.token);
  } catch {
    throw new AtlasIntegrityError('JWT de respuesta ilegible.');
  }

  const alg = String(decoded.header.alg ?? '').toLowerCase();
  if (alg === 'none') return fail('el banco respondio un JWT sin firma (alg: none)');
  if (alg !== 'rs256') throw new AtlasIntegrityError(`Algoritmo de firma no admitido: ${alg}`);

  const signatureOk = verify('RSA-SHA256', Buffer.from(decoded.signingInput), opts.bankPublicKey, decoded.signature);
  if (!signatureOk) throw new AtlasIntegrityError('Firma del JWT de respuesta invalida.');

  const exp = Number(decoded.payload.exp);
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Number.isFinite(exp) && exp < now - 60) throw new AtlasIntegrityError('JWT de respuesta vencido.');

  const aud = decoded.payload.aud;
  if (aud !== undefined && aud !== opts.aud) {
    throw new AtlasIntegrityError(`Audiencia inesperada: ${String(aud)} (se esperaba ${opts.aud}).`);
  }

  // Sin revelar valores: el claim `auth` es el token de la cuenta.
  for (const [claim, expected] of Object.entries(opts.expectedClaims ?? {})) {
    if (claim === 'content-hash') continue;
    if (!sameClaim(decoded.payload[claim], expected)) {
      throw new AtlasIntegrityError(`El claim ${claim} no coincide con la solicitud.`);
    }
  }

  // El hash es lo que ata la firma al cuerpo: sin el, una firma valida no protege los datos.
  const expectedHash = decoded.payload['content-hash'];
  if (typeof expectedHash !== 'string' || !expectedHash) {
    throw new AtlasIntegrityError('El JWT de respuesta no contiene content-hash.');
  }
  if (!sameClaim(sha256Hex(opts.body), expectedHash)) throw new AtlasIntegrityError('content-hash no coincide con el cuerpo.');
  return { verified: true };
};
