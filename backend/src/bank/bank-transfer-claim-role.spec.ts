import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '../users/entities/user.entity';
import { BankTransfersService } from './bank-transfers.service';
import { ClaimReferenceType } from './entities/bank-transfer-claim.entity';

const request = {
  referenceType: ClaimReferenceType.TICKET,
  referenceValue: 'TICKET-123',
  idempotencyKey: 'claim-role-test',
};

describe('BankTransfersService direct claim roles', () => {
  it.each([UserRole.COBRADOR, UserRole.SUPERVISOR])(
    'rejects %s before opening a transaction',
    async (role) => {
      const dataSource = { transaction: jest.fn() };
      const service = new BankTransfersService(
        dataSource as any,
        {} as any,
        {} as any,
      );

      await expect(
        service.claim('transfer-1', request, { userId: 'user-1', role }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    },
  );

  it.each([UserRole.CAJERO, UserRole.ADMIN])(
    'lets %s reach the locked transaction',
    async (role) => {
      const reachedTransaction = new Error('reached locked transaction');
      const dataSource = {
        transaction: jest.fn().mockRejectedValue(reachedTransaction),
      };
      const service = new BankTransfersService(
        dataSource as any,
        {} as any,
        {} as any,
      );

      await expect(
        service.claim('transfer-1', request, { userId: 'user-1', role }),
      ).rejects.toBe(reachedTransaction);
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    },
  );
});
