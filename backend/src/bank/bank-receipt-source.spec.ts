import { BankTransfersService } from './bank-transfers.service';
import { BankTransferSource } from './entities/bank-transfer.entity';
import { ClaimReferenceType, ClaimStatus } from './entities/bank-transfer-claim.entity';

describe('bank receipt source', () => {
  it.each([BankTransferSource.ATLAS, BankTransferSource.MOCK])('preserves %s in the printed receipt DTO', (source) => {
    const service = new BankTransfersService({} as any, {} as any, {} as any);
    const receipt = (service as any).toReceipt({
      source,
      amount: 1000,
      currency: 'PYG',
      senderName: 'REMITENTE',
      bankDocNumber: 'DOC-1',
      movementAt: new Date('2026-09-24T12:00:00Z'),
    }, {
      receiptNumber: 'TC-1',
      claimedAt: new Date('2026-09-24T12:01:00Z'),
      claimedByName: 'CAJERO',
      claimedByUsername: 'caja',
      claimedByRole: 'CAJERO',
      referenceType: ClaimReferenceType.TICKET,
      referenceValue: 'T-1',
      amount: 1000,
      printCount: 1,
      status: ClaimStatus.ACTIVA,
    });
    expect(receipt.source).toBe(source);
  });
});
