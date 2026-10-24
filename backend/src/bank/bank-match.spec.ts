import { assessMatch, senderAccountKey } from './bank-match';

const transfer = (patch: Record<string, unknown> = {}) => ({
  amount: 200000,
  allocatedAmount: 0,
  movementAt: new Date('2026-10-24T12:00:00Z'),
  bankDocNumber: 'OPER-991122',
  sipapReference: null,
  senderName: 'ANA LOREIRO ARGUELLO',
  senderBankName: 'UENO BANK SOCIEDAD ANONIMA',
  senderNote: null,
  concept: 'TRANSFERENCIA RECIBIDA',
  ...patch,
});

const payment = (patch: Record<string, unknown> = {}) => ({
  amount: 200000,
  allocatedAmount: 0,
  createdAt: new Date('2026-10-24T12:30:00Z'),
  paymentRef: '52631',
  clientCode: '7098',
  clientName: 'Ana Loreiro Arguello',
  sourceBank: 'UENO BANK',
  isAtlasAccount: true,
  ...patch,
});

describe('Correlación de transferencias con varias señales independientes', () => {
  it('el mismo monto y una hora cercana no identifican al cliente', () => {
    const match = assessMatch(
      transfer({ senderName: 'PEDRO ORTIZ', senderBankName: null }),
      payment({ sourceBank: null }),
    );
    expect(match.strength).toBe('DEBIL');
    expect(match.evidence).toContain('MONTO');
  });

  it('una consulta BNF no se vuelve fuerte contra Atlas por coincidir la referencia', () => {
    const match = assessMatch(transfer(), payment({ isAtlasAccount: false, paymentRef: 'OPER-991122' }));
    expect(match.strength).toBe('DEBIL');
    expect(match).toEqual(expect.objectContaining({ conflicts: expect.arrayContaining(['DESTINO']) }));
  });

  it('nombre completo, monto, banco y fecha cercana dan fuerza sin exigir referencia exacta', () => {
    const match = assessMatch(transfer(), payment());
    expect(match.strength).toBe('FUERTE');
    expect(match.evidence).toEqual(expect.arrayContaining(['NOMBRE', 'MONTO', 'BANCO', 'FECHA']));
    expect(match.evidence).not.toContain('REFERENCIA');
    expect(match).toEqual(expect.objectContaining({ conflicts: [] }));
  });

  it('tolera nombres completos en otro orden y sin acentos', () => {
    const match = assessMatch(
      transfer({ senderName: 'BENITEZ, MARIA ELENA' }),
      payment({ clientName: 'María Elena Benítez' }),
    );
    expect(match.strength).toBe('FUERTE');
    expect(match.evidence).toContain('NOMBRE');
  });

  it('un banco de origen explícitamente distinto exige revisión aunque haya otros parecidos', () => {
    const match = assessMatch(transfer(), payment({ sourceBank: 'BANCO ITAU' }));
    expect(match.strength).toBe('DEBIL');
    expect(match).toEqual(expect.objectContaining({ conflicts: expect.arrayContaining(['BANCO']) }));
  });

  it('un apellido aislado no cuenta como identidad coincidente', () => {
    const match = assessMatch(transfer(), payment({ clientName: 'ARGUELLO' }));
    expect(match.evidence).not.toContain('NOMBRE');
    expect(match.strength).toBe('DEBIL');
  });

  it('dos apariciones de una misma palabra no sustituyen dos palabras de nombre', () => {
    const match = assessMatch(
      transfer({ senderName: 'MARIA GONZALEZ' }),
      payment({ clientName: 'MARIA MARIA' }),
    );
    expect(match.evidence).not.toContain('NOMBRE');
    expect(match.strength).toBe('DEBIL');
  });

  it('el código 7098 no identifica una operación que contiene el número 1709800', () => {
    const match = assessMatch(transfer({ senderNote: 'operación 1709800' }), payment());
    expect(match.evidence).not.toContain('CONCEPTO');
  });

  it('un código completo separado dentro del concepto sí aporta identidad', () => {
    const match = assessMatch(transfer({ concept: 'Pago cliente 7098 cuota octubre' }), payment());
    expect(match.evidence).toContain('CONCEPTO');
  });

  it('un sufijo numérico corto se presenta como referencia parcial', () => {
    const match = assessMatch(transfer({ bankDocNumber: '202610242252631' }), payment());
    expect(match.evidence).toContain('REFERENCIA_PARCIAL');
    expect(match.evidence).not.toContain('REFERENCIA');
  });

  it('una referencia parcial sin identidad no se vuelve fuerte por el monto y la fecha', () => {
    const match = assessMatch(
      transfer({ bankDocNumber: '202610242252631', senderName: 'PEDRO ORTIZ', senderBankName: null }),
      payment({ sourceBank: null }),
    );
    expect(match.evidence).toContain('REFERENCIA_PARCIAL');
    expect(match.strength).toBe('DEBIL');
  });

  it('un banco no informado es ausencia de evidencia, no una contradicción', () => {
    const match = assessMatch(transfer({ senderBankName: null }), payment());
    expect(match.evidence).not.toContain('BANCO');
    expect(match).toEqual(expect.objectContaining({ conflicts: [] }));
    expect(match.strength).not.toBe('FUERTE');
  });

  it('prioriza la referencia completa sobre un cruce por nombre, banco, monto y fecha', () => {
    const full = assessMatch(transfer(), payment({ paymentRef: 'OPER-991122' }));
    const contextual = assessMatch(transfer(), payment());
    expect(full.score).toBeGreaterThan(contextual.score);
    const manySignals = assessMatch(transfer({ senderAccount: '123', senderNote: 'cliente 7098 referencia 52631' }), payment(), '7098');
    expect(full.score).toBeGreaterThan(manySignals.score);
  });

  it('reconoce la misma cuenta con las variantes societarias del nombre del banco', () => {
    expect(senderAccountKey({ senderAccount: '123', senderBankName: 'BANCO FAMILIAR S.A.E.C.A.' }))
      .toBe(senderAccountKey({ senderAccount: '123', senderBankName: 'FAMILIAR' }));
  });

  it('no presenta un codigo de cliente como fuerte cuando difiere el monto', () => {
    const match = assessMatch(transfer({ senderNote: 'cliente 7098', amount: 500000 }), payment());
    expect(match.evidence).toContain('CONCEPTO');
    expect(match.strength).not.toBe('FUERTE');
  });

  it('usa el banco y la referencia de movimientos históricos sin reescribirlos', () => {
    const match = assessMatch(transfer({ senderBankName: null, rawPayload: { infoAdicional: {
      des_swi_ban_remitente: 'UENO BANK SOCIEDAD ANONIMA', nro_ref_externa: '52631',
    } } }), payment());
    expect(match.evidence).toEqual(expect.arrayContaining(['BANCO', 'REFERENCIA']));
    expect(match.strength).toBe('FUERTE');
  });

  it('conserva la coincidencia de monto original aunque la transferencia ya esté tomada', () => {
    const match = assessMatch(transfer({ allocatedAmount: 200000, status: 'TOMADA' }), payment());
    expect(match.evidence).toContain('MONTO');
    expect(match.strength).toBe('FUERTE');
  });

  it.each([
    [{ currency: 'USD' }, { currency: 'PYG' }, 'MONEDA'],
    [{ movementAt: new Date('2026-09-24T12:00:00Z') }, {}, 'FECHA'],
    [{ status: 'REVERSADA' }, {}, 'ESTADO'],
  ])('expone contradicciones aun con una referencia exacta (%s)', (bank, consulta, conflict) => {
    const match = assessMatch(transfer(bank as Record<string, unknown>), payment({ ...consulta as Record<string, unknown>, paymentRef: 'OPER-991122' }));
    expect(match.conflicts).toContain(conflict);
    expect(match.strength).toBe('DEBIL');
  });
});
