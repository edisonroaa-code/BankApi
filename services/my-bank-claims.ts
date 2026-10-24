import type { BankClaim, BankTransfer } from '../types';

/** El endpoint de historial propio devuelve una fila por toma, incluso si ya fue anulada. */
export const ownClaimRows = (transfers: BankTransfer[], userId: string) =>
  transfers.flatMap((transfer) => transfer.claims
    .filter((claim) => claim.claimedById === userId)
    .map((claim) => ({ transfer, claim })));

export const canReprintOwnClaim = (claim: BankClaim, userId: string, role = 'COBRADOR') =>
  claim.status === 'ACTIVA' && (role === 'ADMIN' || (claim.claimedById === userId && Number(claim.printCount ?? 0) <= 0 && !claim.printIssued));

/** Una anulación quita la toma del payload activo; el ID del historial propio permite detectarla. */
export const ownClaimsAffectedByTransfer = (
  updated: Pick<BankTransfer, 'id' | 'claims'>,
  visibleHistory: Pick<BankTransfer, 'id'>[],
  userId: string,
) => updated.claims.some((claim) => claim.claimedById === userId) ||
  visibleHistory.some((transfer) => transfer.id === updated.id);
