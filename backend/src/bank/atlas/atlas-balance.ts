import { AtlasContractError, strictNumber } from './atlas-movements';

/**
 * Consulta de Saldo v0.9: port de `_parse_saldo_response` del laboratorio.
 * Los opcionales quedan en null cuando el banco no los informa: convertirlos en 0 afirmaria
 * un dato que el banco no dio. Solo lo consulta el ADMIN y a pedido; nunca viaja por las salas
 * en vivo que comparten caja y cobradores.
 */
export type AtlasBalance = {
  nroCuenta: string;
  producto: { codigo: number; descripcion: string; descripcionCorta: string | null };
  moneda: string;
  saldo: number;
  saldoDisponible: number;
  depositoConfirmar: number | null;
  saldoBloqueado: number | null;
  saldoProtegido: number | null;
  saldoPromedio: number | null;
};

const fail = (field: string) => new AtlasContractError(`Campo invalido o ausente en respuesta de Atlas: '${field}' (saldo)`);

const requiredField = (obj: Record<string, unknown>, field: string) => {
  const value = obj[field];
  if (value === null || value === undefined) throw fail(field);
  return value;
};

const optionalAmount = (obj: Record<string, unknown>, field: string) =>
  obj[field] === null || obj[field] === undefined ? null : strictNumber(obj[field], field, 'saldo');

const SALDO_INFO_NUMBERS = [
  'dias_sobregiro',
  'dias_mora',
  'linea_sobregiro',
  'liquidacion_sobregiro',
  'monto_mov_pendientes',
  'monto_mov_pendiente_asincronos',
  'monto_mov_pendiente_infonet',
];

export const parseBalanceResponse = (data: unknown, expectedAccount: string): AtlasBalance => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AtlasContractError('Respuesta de saldo con formato inesperado.');
  const row = data as Record<string, unknown>;

  const nroCuenta = requiredField(row, 'nroCuenta');
  if (typeof nroCuenta !== 'string' || !/^[0-9]+$/.test(nroCuenta) || nroCuenta !== expectedAccount) throw fail('nroCuenta');

  const productoRaw = requiredField(row, 'producto');
  if (typeof productoRaw !== 'object' || Array.isArray(productoRaw)) throw fail('producto');
  const producto = productoRaw as Record<string, unknown>;
  const descripcion = requiredField(producto, 'descripcion');
  if (typeof descripcion !== 'string' || !descripcion.trim()) throw fail('producto.descripcion');
  const corta = producto.descripcionCorta;
  if (corta !== null && corta !== undefined && typeof corta !== 'string') throw fail('producto.descripcionCorta');

  const moneda = requiredField(row, 'moneda');
  if (typeof moneda !== 'string' || !/^[A-Z]{3}$/.test(moneda)) throw fail('moneda');

  const info = row.infoAdicional;
  if (info !== null && info !== undefined) {
    if (typeof info !== 'object' || Array.isArray(info)) throw fail('infoAdicional');
    for (const field of SALDO_INFO_NUMBERS) {
      const value = (info as Record<string, unknown>)[field];
      if (value !== null && value !== undefined) {
        strictNumber(value, `infoAdicional.${field}`, 'saldo', field === 'dias_sobregiro' || field === 'dias_mora');
      }
    }
  }

  return {
    nroCuenta,
    producto: {
      codigo: strictNumber(requiredField(producto, 'codigo'), 'producto.codigo', 'saldo', true),
      descripcion,
      descripcionCorta: (corta as string | null | undefined) ?? null,
    },
    moneda,
    saldo: strictNumber(requiredField(row, 'saldo'), 'saldo', 'saldo'),
    saldoDisponible: strictNumber(requiredField(row, 'saldoDisponible'), 'saldoDisponible', 'saldo'),
    depositoConfirmar: optionalAmount(row, 'depositoConfirmar'),
    saldoBloqueado: optionalAmount(row, 'saldoBloqueado'),
    saldoProtegido: optionalAmount(row, 'saldoProtegido'),
    saldoPromedio: optionalAmount(row, 'saldoPromedio'),
  };
};
