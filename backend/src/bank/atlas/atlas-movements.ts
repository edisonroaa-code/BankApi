/**
 * Validacion estricta de `listaMovimiento` (Consulta de Movimientos v1.1, detallado).
 * Port de `_normalize_movement` del laboratorio. Un dato obligatorio ausente o con otro tipo es
 * un error de contrato: nunca se inventan ceros, ni se convierte texto en dinero, ni se omiten filas.
 */

export class AtlasContractError extends Error {
  readonly code = 'ATLAS_CONTRACT_ERROR';
}

export type AtlasMovement = {
  monto: number;
  numeroCuenta: string;
  moneda: string;
  concepto: string;
  tipoMovimiento: string;
  fechaMovimiento: string;
  fechaProceso: string | null;
  nroDocumento: string | null;
  nroTransaccionBancard: string | null;
  /** Metadata validada; `{}` cuando el banco manda null. El original queda en `raw`. */
  infoAdicional: Record<string, unknown>;
  raw: Record<string, unknown>;
};

const contractError = (field: string, context: string) =>
  new AtlasContractError(`Campo invalido o ausente en respuesta de Atlas: '${field}' (${context})`);

/** `label` nombra el campo completo en el error (p. ej. "moneda.codigo"). */
const required = (item: Record<string, unknown>, field: string, context: string, label = field) => {
  const value = item[field];
  if (value === null || value === undefined) throw contractError(label, context);
  return value;
};

/** Numeros JSON reales: nunca booleano, texto, NaN ni infinito. */
export const strictNumber = (value: unknown, field: string, context: string, integer = false): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw contractError(field, context);
  }
  return value;
};

/**
 * `cod_tra_padre` y `cod_transaccion` llegan del banco tambien como texto ("602" o "602.0"),
 * aunque el manual los declara Integer (observado en el laboratorio el 2026-10-07). Se acepta
 * ese formato SOLO para estos dos codigos de auditoria; importes y el resto siguen estrictos.
 */
export const auditInteger = (value: unknown, field: string, context: string): number | string => {
  if (typeof value === 'string') {
    if (!/^[0-9]+(?:\.0+)?$/.test(value.trim())) throw contractError(field, context);
    return value;
  }
  return strictNumber(value, field, context, true);
};

const strictText = (value: unknown, field: string, context: string, nonEmpty = false): string => {
  if (typeof value !== 'string' || (nonEmpty && !value.trim())) throw contractError(field, context);
  return value;
};

/** La cuenta de la respuesta tiene que ser la que se consulto: nunca mezclar cuentas. */
const accountIdentity = (value: unknown, context: string, expected?: string): string => {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) throw contractError('numeroCuenta', context);
  if (expected !== undefined && value !== expected) throw contractError('numeroCuenta', context);
  return value;
};

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:[0-5]\d)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Fecha ISO real (no solo con forma de fecha): 2026-02-30 se rechaza. */
const isoDate = (value: unknown, field: string, context: string, dateAllowed = false): string => {
  if (typeof value !== 'string') throw contractError(field, context);
  if (dateAllowed && ISO_DATE.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw contractError(field, context);
    return value;
  }
  if (!ISO_DATETIME.test(value)) throw contractError(field, context);
  const [, y, mo, d, h, mi, s] = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value)!;
  const probe = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  if (
    probe.getUTCFullYear() !== +y ||
    probe.getUTCMonth() !== +mo - 1 ||
    probe.getUTCDate() !== +d ||
    probe.getUTCHours() !== +h ||
    probe.getUTCMinutes() !== +mi ||
    probe.getUTCSeconds() !== +s
  ) {
    throw contractError(field, context);
  }
  return value;
};

const currencyIso = (value: unknown, field: string, context: string): string => {
  // Atlas documenta ARP: se acepta aunque difiera de ISO 4217.
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) throw contractError(field, context);
  return value;
};

/** Codigo de moneda del banco -> ISO, segun la tabla de Movimientos v1.1. */
const CURRENCY_BY_CODE: Record<number, string> = { 6900: 'PYG', 1: 'USD', 62: 'EUR', 9: 'BRL', 10: 'ARP' };

const parseMoneda = (raw: unknown, context: string): string => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const iso = currencyIso(required(obj, 'iso', context, 'moneda.iso'), 'moneda.iso', context);
    const code = strictNumber(required(obj, 'codigo', context, 'moneda.codigo'), 'moneda.codigo', context, true);
    strictText(required(obj, 'nombre', context, 'moneda.nombre'), 'moneda.nombre', context, true);
    strictText(required(obj, 'abreviatura', context, 'moneda.abreviatura'), 'moneda.abreviatura', context, true);
    if (obj.simbolo !== null && obj.simbolo !== undefined) strictText(obj.simbolo, 'moneda.simbolo', context);
    const expected = CURRENCY_BY_CODE[code];
    if (expected && iso !== expected && !(code === 10 && iso === 'ARS')) throw contractError('moneda.iso', context);
    return iso;
  }
  if (typeof raw === 'string') return currencyIso(raw, 'moneda', context);
  throw contractError('moneda', context);
};

const INFO_NUMBERS = ['cod_tra_padre', 'cod_transaccion'];
const INFO_TEXTS = [
  'estado',
  'cod_usuario',
  'usu_insercion',
  'reversado',
  'cod_usu_reversion',
  'des_tra_padre',
  'des_transaccion',
  'nro_doc_remitente',
  'nom_remitente',
  'nro_cta_remitente',
  'concepto',
];

/** Valida los campos conocidos sin descartar metadata nueva ni nulls del banco. */
const parseInfoAdicional = (raw: unknown, context: string): Record<string, unknown> => {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw contractError('infoAdicional', context);
  const info = raw as Record<string, unknown>;
  for (const field of INFO_NUMBERS) {
    if (info[field] !== null && info[field] !== undefined) auditInteger(info[field], `infoAdicional.${field}`, context);
  }
  for (const field of INFO_TEXTS) {
    if (info[field] !== null && info[field] !== undefined) strictText(info[field], `infoAdicional.${field}`, context);
  }
  if (info.reversado !== null && info.reversado !== undefined && info.reversado !== 'N' && info.reversado !== 'S') {
    throw contractError('infoAdicional.reversado', context);
  }
  return info;
};

/** El banco envia enteros como 602, 602.0 o "602.0": todos se guardan como "602". */
export const normalizeNumericText = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return String(value);
  const text = String(value).trim();
  if (/^-?\d+\.0+$/.test(text)) return text.replace(/\.0+$/, '');
  return text;
};

const MOVEMENT_TYPES = new Set(['D', 'C', 'DEBITO', 'CREDITO']);

const parseMovement = (row: Record<string, unknown>, context: string, expectedAccount?: string): AtlasMovement => {
  const monto = strictNumber(required(row, 'monto', context), 'monto', context);
  const numeroCuenta = accountIdentity(required(row, 'numeroCuenta', context), context, expectedAccount);
  const moneda = parseMoneda(required(row, 'moneda', context), context);
  const concepto = strictText(required(row, 'concepto', context), 'concepto', context);
  const tipoMovimiento = strictText(required(row, 'tipoMovimiento', context), 'tipoMovimiento', context).toUpperCase();
  if (!MOVEMENT_TYPES.has(tipoMovimiento)) throw contractError('tipoMovimiento', context);
  const fechaMovimiento = isoDate(required(row, 'fechaMovimiento', context), 'fechaMovimiento', context);

  // v1.1 usa la clave literal "fecha Proceso" (con espacio); se acepta tambien sin espacio.
  // Ningun alias puede ocultar una fecha invalida ni contradecir al otro.
  const processDates: string[] = [];
  for (const field of ['fecha Proceso', 'fechaProceso']) {
    if (field in row && row[field] !== null && row[field] !== undefined) processDates.push(isoDate(row[field], field, context, true));
  }
  if (processDates.length === 2 && processDates[0] !== processDates[1]) throw contractError('fechaProceso', context);

  const optionalInteger = (field: string) =>
    row[field] === null || row[field] === undefined ? null : normalizeNumericText(strictNumber(row[field], field, context, true));

  return {
    monto,
    numeroCuenta,
    moneda,
    concepto,
    tipoMovimiento,
    fechaMovimiento,
    fechaProceso: processDates[0] ?? null,
    nroDocumento: optionalInteger('nroDocumento'),
    nroTransaccionBancard: optionalInteger('nroTransaccionBancard'),
    infoAdicional: parseInfoAdicional(row.infoAdicional, context),
    raw: row,
  };
};

/**
 * `expectedAccount`: la cuenta consultada. Si el banco devuelve un movimiento de otra cuenta,
 * la respuesta entera se rechaza: registrarlo seria mostrar dinero que no entro a esta cuenta.
 */
export const parseMovementsResponse = (data: unknown, expectedAccount?: string): AtlasMovement[] => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new AtlasContractError('Respuesta de movimientos con formato inesperado.');
  }
  const list = (data as Record<string, unknown>).listaMovimiento;
  if (list === undefined || list === null) throw contractError('listaMovimiento', 'respuesta de movimientos');
  if (!Array.isArray(list)) throw contractError('listaMovimiento', 'respuesta de movimientos');

  return list.map((item, idx) => {
    const context = `movimiento[${idx}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw contractError('listaMovimiento', context);
    return parseMovement(item as Record<string, unknown>, context, expectedAccount);
  });
};

export const isCredit = (movement: AtlasMovement) => movement.tipoMovimiento === 'C' || movement.tipoMovimiento === 'CREDITO';

export const isReversed = (movement: AtlasMovement) =>
  String(movement.infoAdicional.reversado ?? 'N').trim().toUpperCase() === 'S';
