import { AtlasContractError, normalizeNumericText } from './atlas-movements';

/**
 * Consulta de Operaciones SIPAP y catalogo de entidades (Transferencias v1.4). Se usan solo para
 * completar el banco de origen de un credito: Movimientos v1.1 no lo informa.
 */

export type SipapOperation = {
  nroReferencia: string | null;
  nroOperacion: string | null;
  tipTransferencia: string | null;
  monto: number;
  fecha: string | null;
  concepto: string | null;
  motivo: string | null;
  codSwiPteSolicitante: string | null;
  nroCtaSolicitante: string | null;
  nroDocSolicitante: string | null;
  nomSolicitante: string | null;
  codSwiPteBeneficiario: string | null;
  nroCtaBeneficiario: string | null;
  situacion: string | null;
  estado: string | null;
};

export type BankEntity = { codigo: string; descripcion: string; descripcionCorta: string | null };

const text = (value: unknown) => {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
};

export const parseSipapOperationsResponse = (data: unknown): SipapOperation[] => {
  const list = (data as Record<string, unknown> | null)?.operacionesSipap;
  if (!Array.isArray(list)) throw new AtlasContractError("Campo obligatorio ausente en respuesta de Atlas: 'operacionesSipap'");
  return list
    .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    .map((row) => ({
      nroReferencia: normalizeNumericText(row.nroReferencia),
      nroOperacion: normalizeNumericText(row.nroOperacion),
      tipTransferencia: text(row.tipTransferencia),
      monto: Number(row.monto),
      fecha: text(row.fecha),
      concepto: text(row.concepto),
      motivo: text(row.motivo),
      codSwiPteSolicitante: text(row.codSwiPteSolicitante),
      nroCtaSolicitante: text(row.nroCtaSolicitante),
      nroDocSolicitante: text(row.nroDocSolicitante),
      nomSolicitante: text(row.nomSolicitante),
      codSwiPteBeneficiario: text(row.codSwiPteBeneficiario),
      nroCtaBeneficiario: text(row.nroCtaBeneficiario),
      situacion: text(row.situacion),
      estado: text(row.estado),
    }))
    // Una operacion sin monto no se puede vincular: se descarta en lugar de adivinar.
    .filter((op) => Number.isFinite(op.monto));
};

export const parseEntitiesResponse = (data: unknown): BankEntity[] => {
  const list = (data as Record<string, unknown> | null)?.listaDatos;
  if (!Array.isArray(list)) throw new AtlasContractError("Campo obligatorio ausente en respuesta de Atlas: 'listaDatos'");
  return list
    .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !!row.codigo)
    .map((row) => ({
      codigo: String(row.codigo).trim(),
      descripcion: String(row.descripcion ?? row.codigo).trim(),
      descripcionCorta: text(row.descripcionCorta),
    }));
};

/** Cuentas y documentos se comparan sin guiones, puntos, espacios ni ceros a la izquierda. */
export const normalizeIdentifier = (value: string | null | undefined) =>
  (value ?? '').replace(/[^0-9A-Za-z]/g, '').replace(/^0+(?=.)/, '').toUpperCase();

/**
 * Vincula un credito con su operacion SIPAP: mismo monto, misma cuenta del remitente, documento
 * compatible y fecha a no mas de un dia. Solo se acepta un vinculo UNICO; si hay dos candidatas
 * no se asigna ninguna (mejor "no informado" que un banco equivocado).
 * Regla pendiente de validar con datos reales: el sandbox no tiene transferencias.
 */
export const matchSipapOperation = (
  credit: { amount: number; senderAccount: string | null; senderDoc: string | null; movementAt: Date },
  operations: SipapOperation[],
  usedReferences: Set<string>,
): SipapOperation | null => {
  const account = normalizeIdentifier(credit.senderAccount);
  if (!account) return null;
  const doc = normalizeIdentifier(credit.senderDoc);
  const candidates = operations.filter((op) => {
    if (op.monto !== credit.amount) return false;
    if (normalizeIdentifier(op.nroCtaSolicitante) !== account) return false;
    const opDoc = normalizeIdentifier(op.nroDocSolicitante);
    if (doc && opDoc && opDoc !== doc) return false;
    if (op.nroReferencia && usedReferences.has(op.nroReferencia)) return false;
    if (op.fecha) {
      const at = new Date(op.fecha).getTime();
      if (Number.isFinite(at) && Math.abs(at - credit.movementAt.getTime()) > 36 * 60 * 60 * 1000) return false;
    }
    return true;
  });
  return candidates.length === 1 ? candidates[0] : null;
};
