import { EntityManager, In } from 'typeorm';
import { BankTransferClaim, ClaimStatus } from '../bank/entities/bank-transfer-claim.entity';
import { Payment } from './entities/payment.entity';
import { AuditLog } from './entities/audit-log.entity';
import { PRINT_OPEN_ACTIONS, printMetadata } from './print-authorization';

export const hasPendingAdminReviewSql = (alias: string) => `(${alias}."isAtlasAccount" = true AND (
  NOT EXISTS (SELECT 1 FROM bank_transfer_claims c WHERE c."paymentId" = ${alias}.id AND c.status = 'ACTIVA') OR
  EXISTS (SELECT 1 FROM bank_transfer_claims c WHERE c."paymentId" = ${alias}.id AND c.status = 'ACTIVA' AND
    NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.action = 'BANK_CLAIM_REVIEWED' AND a."paymentId" = c."paymentId"
      AND a."bankTransferId" = c."bankTransferId" AND a.metadata LIKE '%"claimId":"' || c.id::text || '"%'))))`;

/** Datos derivados de evidencia persistente; no se presume una revisión ni se reescribe historia. */
export async function attachPaymentControls<T extends Payment>(manager: EntityManager, payments: T[]): Promise<T[]> {
  if (!payments.length) return payments;
  const eligible = payments.filter((p) => p.isAtlasAccount === true || (!p.printedAt && ['CONFIRMADO', 'CONFIRMADO_MANUAL'].includes(p.status)));
  if (!eligible.length) return payments.map((p) => Object.assign(p, { ticketIssued: !!p.printedAt }));
  const ids = eligible.map((p) => p.id);
  const atlasIds = eligible.filter((p) => p.isAtlasAccount === true).map((p) => p.id);
  const [claims, logs] = await Promise.all([
    atlasIds.length ? manager.getRepository(BankTransferClaim).find({ where: { paymentId: In(atlasIds), status: ClaimStatus.ACTIVA } }) : Promise.resolve([]),
    manager.getRepository(AuditLog).find({ where: { paymentId: In(ids), action: In(['BANK_CLAIM_REVIEWED', ...PRINT_OPEN_ACTIONS]) }, order: { timestamp: 'DESC' } }),
  ]);
  return payments.map((p) => {
    const ownLogs = logs.filter((l) => l.paymentId === p.id);
    const ticketIssued = !!p.printedAt || ownLogs.some((l) => PRINT_OPEN_ACTIONS.includes(l.action) && (printMetadata(l).scopeKey === `PAYMENT:${p.id}` || l.action === 'PAYMENT_PRINT_OPENED'));
    if (p.isAtlasAccount !== true) return Object.assign(p, { ticketIssued });
    const parts = claims.filter((c) => c.paymentId === p.id).map((c) => {
      const review = ownLogs.find((l) => l.action === 'BANK_CLAIM_REVIEWED' && printMetadata(l).claimId === c.id);
      return { claimId: c.id, transferId: c.bankTransferId, receiptNumber: c.receiptNumber, amount: Number(c.amount),
        reviewedAt: review?.timestamp ?? null, reviewedBy: review ? printMetadata(review).reviewedByName || review.actorUsername || review.userId : null };
    });
    const pendingCount = parts.filter((c) => !c.reviewedAt).length;
    const done = parts.length > 0 && pendingCount === 0;
    const last = done ? [...parts].sort((a, b) => new Date(b.reviewedAt!).getTime() - new Date(a.reviewedAt!).getTime())[0] : null;
    return Object.assign(p, { ticketIssued, adminReview: { required: true, status: done ? 'REVIEWED' : 'PENDING', totalCount: parts.length, pendingCount,
      reviewedAt: last?.reviewedAt ?? null, reviewedBy: last?.reviewedBy ?? null, claims: parts } });
  });
}
