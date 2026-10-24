import { matchSipapOperation, normalizeIdentifier, parseEntitiesResponse, parseSipapOperationsResponse } from './atlas-sipap';

// Operacion de ejemplo del manual "API de Transferencias v1.4" (Consulta de Operaciones SIPAP).
const MANUAL_OPERATION = {
  nroReferencia: 220926239782,
  tipTransferencia: 'SPI',
  moneda: { nombre: 'Guaranies', codigo: 6900, iso: 'PYG', simbolo: 'Gs', abreviatura: 'GS' },
  monto: 50000,
  fechaOperacion: '26/9/22',
  fecha: '2022-09-26T00:00:00-04:00',
  concepto: 'pago',
  codMotivo: '7',
  motivo: 'Ayuda Familiar',
  situacion: 'L',
  estado: 'A',
  nroOperacion: 220926239782,
  codTipDocSolicitante: '1',
  nroDocSolicitante: '5555139',
  nomSolicitante: 'LIZ NATALIA CORONEL ESTIGARRIBIA',
  codSwiPteSolicitante: 'BNITPYPA',
  nroCtaSolicitante: '1345012',
  codSwiPteBeneficiario: 'VISCPYPA',
  nroCtaBeneficiario: '14896722',
};

const credit = (patch: Partial<{ amount: number; senderAccount: string | null; senderDoc: string | null; movementAt: Date }> = {}) => ({
  amount: 50000,
  senderAccount: '1345012',
  senderDoc: '5.555.139',
  movementAt: new Date('2022-09-26T10:15:00-03:00'),
  ...patch,
});

describe('Operaciones SIPAP y banco de origen', () => {
  const operations = parseSipapOperationsResponse({ totalRegistros: 1, operacionesSipap: [MANUAL_OPERATION] });

  it('lee la operacion del manual con el banco solicitante y el canal', () => {
    expect(operations[0]).toMatchObject({
      nroReferencia: '220926239782',
      tipTransferencia: 'SPI',
      monto: 50000,
      codSwiPteSolicitante: 'BNITPYPA',
      nroCtaSolicitante: '1345012',
      motivo: 'Ayuda Familiar',
    });
  });

  it('vincula por monto y cuenta del remitente, con documento compatible', () => {
    expect(matchSipapOperation(credit(), operations, new Set())?.codSwiPteSolicitante).toBe('BNITPYPA');
  });

  it('no vincula si cambia el monto, la cuenta o el documento', () => {
    expect(matchSipapOperation(credit({ amount: 50001 }), operations, new Set())).toBeNull();
    expect(matchSipapOperation(credit({ senderAccount: '999' }), operations, new Set())).toBeNull();
    expect(matchSipapOperation(credit({ senderDoc: '1234567' }), operations, new Set())).toBeNull();
    expect(matchSipapOperation(credit({ senderAccount: null }), operations, new Set())).toBeNull();
  });

  it('no reutiliza una operacion ya asignada ni elige entre dos candidatas', () => {
    expect(matchSipapOperation(credit(), operations, new Set(['220926239782']))).toBeNull();
    const twins = parseSipapOperationsResponse({ operacionesSipap: [MANUAL_OPERATION, { ...MANUAL_OPERATION, nroReferencia: 1 }] });
    expect(matchSipapOperation(credit(), twins, new Set())).toBeNull();
  });

  it('descarta operaciones de otra fecha', () => {
    expect(matchSipapOperation(credit({ movementAt: new Date('2022-09-29T10:00:00-03:00') }), operations, new Set())).toBeNull();
  });

  it('normaliza identificadores y lee el catalogo de entidades', () => {
    expect(normalizeIdentifier('80.003.453-8')).toBe('800034538');
    expect(normalizeIdentifier('00112')).toBe('112');
    expect(parseEntitiesResponse({ listaDatos: [{ codigo: 'AMAMPYPA', descripcion: 'BANCO BASA SA', descripcionCorta: 'BASA' }] })).toEqual([
      { codigo: 'AMAMPYPA', descripcion: 'BANCO BASA SA', descripcionCorta: 'BASA' },
    ]);
  });
});
