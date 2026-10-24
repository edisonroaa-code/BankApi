import { isClaimable, remainingCents, resolveAmountToClaim, statusFromAllocation } from './bank-allocation';
import { assessMatch, MatchEvidence } from './bank-match';
import { BankTransferStatus } from './entities/bank-transfer.entity';

const transfer = (patch: Partial<Record<string, any>> = {}) => ({
  amount: 500000,
  allocatedAmount: 0,
  status: BankTransferStatus.DISPONIBLE,
  movementAt: new Date('2026-09-21T13:00:00Z'),
  bankDocNumber: '106188',
  sipapReference: 'SIPAP-99887766',
  bancardTxId: null,
  senderAccount: '111666',
  senderName: 'MARIA BENITEZ',
  senderNote: 'pago',
  concept: 'TRANSFERENCIA SPI',
  ...patch,
});

const payment = (patch: Partial<Record<string, any>> = {}) => ({
  amount: 500000,
  allocatedAmount: 0,
  createdAt: new Date('2026-09-21T13:30:00Z'),
  paymentRef: '106188',
  clientCode: 'CL-1012',
  clientName: 'María Benítez',
  ...patch,
});

describe('Saldo de una transferencia', () => {
  it('pasa de disponible a parcial y a tomada segun lo que se tomo', () => {
    expect(statusFromAllocation(transfer())).toBe(BankTransferStatus.DISPONIBLE);
    expect(statusFromAllocation(transfer({ allocatedAmount: 200000 }))).toBe(BankTransferStatus.PARCIAL);
    expect(statusFromAllocation(transfer({ allocatedAmount: 500000 }))).toBe(BankTransferStatus.TOMADA);
  });

  it('una reversa o un bloqueo mandan sobre el saldo', () => {
    expect(statusFromAllocation(transfer({ status: BankTransferStatus.REVERSADA, allocatedAmount: 0 }))).toBe(BankTransferStatus.REVERSADA);
    expect(isClaimable(transfer({ status: BankTransferStatus.BLOQUEADA }))).toBe(false);
  });

  it('no deja tomar mas de lo que queda libre', () => {
    const libre = remainingCents(transfer({ allocatedAmount: 300000 }));
    expect(libre).toBe(20000000); // 200.000 en centavos
    expect(resolveAmountToClaim(250000, libre)).toEqual({ error: expect.stringContaining('200.000') });
    expect(resolveAmountToClaim(200000, libre)).toEqual({ cents: libre });
    expect(resolveAmountToClaim(0, libre)).toEqual({ error: expect.stringContaining('mayor a cero') });
  });

  it('sin monto pedido toma todo el saldo: el caso normal es uno a uno', () => {
    expect(resolveAmountToClaim(undefined, remainingCents(transfer()))).toEqual({ cents: 50000000 });
  });
});

describe('Evidencia del calce consulta <-> transferencia', () => {
  it('la referencia del comprobante contra el numero de operacion es evidencia fuerte', () => {
    const match = assessMatch(transfer(), payment());
    expect(match.evidence).toContain(MatchEvidence.REFERENCIA);
    expect(match.strength).toBe('FUERTE');
  });

  it('tambien calza contra la referencia SIPAP, con ceros y espacios de por medio', () => {
    const match = assessMatch(transfer({ bankDocNumber: '777' }), payment({ paymentRef: ' 0sipap-99887766 ' }));
    expect(match.evidence).toContain(MatchEvidence.REFERENCIA);
  });

  it('el monto solo no alcanza: dos consultas del mismo valor quedan debiles', () => {
    const match = assessMatch(transfer({ bankDocNumber: '777', sipapReference: null, senderName: 'OTRO' }), payment({ paymentRef: 'X-1', clientName: 'Comercial Sur' }));
    expect(match.evidence).toContain(MatchEvidence.MONTO);
    expect(match.strength).toBe('DEBIL');
  });

  it('una cuenta que ya pago a ese cliente, con el monto exacto, es evidencia fuerte', () => {
    const match = assessMatch(
      transfer({ bankDocNumber: '777', sipapReference: null, senderName: 'OTRO' }),
      payment({ paymentRef: 'X-1', clientName: 'Comercial Sur' }),
      'CL-1012',
    );
    expect(match.evidence).toContain(MatchEvidence.CUENTA_CONOCIDA);
    expect(match.strength).toBe('FUERTE');
  });

  it('el concepto que escribio el remitente sirve si trae la referencia o el codigo del cliente', () => {
    const porCodigo = assessMatch(transfer({ bankDocNumber: '777', sipapReference: null, senderNote: 'pago cl-1012 setiembre' }), payment({ paymentRef: 'X-1' }));
    expect(porCodigo.evidence).toContain(MatchEvidence.CONCEPTO);
    expect(porCodigo.strength).toBe('FUERTE');
  });

  it('no confunde referencias cortas que aparecen por casualidad', () => {
    const match = assessMatch(transfer({ bankDocNumber: '1450', sipapReference: null, senderNote: null }), payment({ paymentRef: '45' }));
    expect(match.evidence).not.toContain(MatchEvidence.REFERENCIA);
  });

  it('ordena mejor el candidato con referencia que el que solo coincide en monto', () => {
    const conReferencia = assessMatch(transfer(), payment());
    const soloMonto = assessMatch(transfer({ bankDocNumber: '777', sipapReference: null, senderName: 'OTRO' }), payment({ paymentRef: 'X-1', clientName: 'Otro' }));
    expect(conReferencia.score).toBeGreaterThan(soloMonto.score);
  });

  it('una transferencia que solo cubre parte de la consulta se marca como parcial', () => {
    const match = assessMatch(transfer({ amount: 200000, bankDocNumber: '777', sipapReference: null }), payment({ paymentRef: 'X-1' }));
    expect(match.evidence).toContain(MatchEvidence.MONTO_PARCIAL);
    expect(match.evidence).not.toContain(MatchEvidence.MONTO);
  });
});
