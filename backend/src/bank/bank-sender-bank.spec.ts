import { parseMovementsResponse } from './atlas/atlas-movements';
import { MANUAL_MOVIMIENTOS_DETALLE } from './atlas/atlas.fixtures';
import { toNormalizedCredit } from './bank-credit';
import { BankTransfersService } from './bank-transfers.service';
import { BankTransfer, BankTransferSource, BankTransferStatus } from './entities/bank-transfer.entity';

// Forma real de los creditos SIPAP de Atlas (13/10/2026): campos que el manual v1.1 no documenta.
const REAL_INFO = {
  cod_swi_ban_remitente: 'COMAPYPA',
  des_swi_ban_remitente: 'UENO BANK SOCIEDAD ANONIMA',
  nro_ref_externa: 'COMAPYPAARES000002610134704012345',
  origen: null,
  sub_tipo: 'T',
  devuelto: 'N',
  puede_devolver: 'S',
};

const movement = (info: Record<string, unknown> = {}) => {
  const base = MANUAL_MOVIMIENTOS_DETALLE.listaMovimiento[0];
  return parseMovementsResponse({ listaMovimiento: [{ ...base, infoAdicional: { ...base.infoAdicional, ...info } }] })[0];
};

describe('Banco de origen de la transferencia', () => {
  it('lo toma del movimiento: SWIFT, nombre del banco y referencia SIPAP', () => {
    expect(toNormalizedCredit(movement(REAL_INFO), BankTransferSource.ATLAS)).toMatchObject({
      senderBankCode: 'COMAPYPA',
      senderBankName: 'UENO BANK SOCIEDAD ANONIMA',
      sipapReference: 'COMAPYPAARES000002610134704012345',
    });
  });

  it('no cambia la huella: lo ya registrado no se vuelve a registrar como nuevo', () => {
    const before = toNormalizedCredit(movement(), BankTransferSource.ATLAS);
    const after = toNormalizedCredit(movement(REAL_INFO), BankTransferSource.ATLAS);
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it('si el banco cambia la forma de esos campos, se ignoran y el movimiento entra igual', () => {
    const odd = toNormalizedCredit(movement({ cod_swi_ban_remitente: 123, des_swi_ban_remitente: { x: 1 }, nro_ref_externa: '  ' }), BankTransferSource.ATLAS);
    expect(odd).toMatchObject({ senderBankCode: null, senderBankName: null, sipapReference: null });
    expect(toNormalizedCredit(movement(), BankTransferSource.ATLAS).senderBankName).toBeNull();
  });

  it('las transferencias registradas antes de la correccion lo muestran desde el movimiento guardado', () => {
    const service = new BankTransfersService({} as any, {} as any, {} as any);
    const old = {
      id: 't1', amount: 202000, allocatedAmount: 0, status: BankTransferStatus.DISPONIBLE, currency: 'PYG',
      senderBankCode: null, senderBankName: null, sipapReference: null,
      rawPayload: { infoAdicional: REAL_INFO },
    } as unknown as BankTransfer;
    expect(service.toDto(old, [], false)).toMatchObject({
      senderBankCode: 'COMAPYPA', senderBankName: 'UENO BANK SOCIEDAD ANONIMA', sipapReference: 'COMAPYPAARES000002610134704012345',
    });
    // Lo guardado en columnas manda sobre el movimiento original.
    const enriched = { ...old, senderBankName: 'BANCO X' } as BankTransfer;
    expect(service.toDto(enriched, [], true).senderBankName).toBe('BANCO X');
  });
});
