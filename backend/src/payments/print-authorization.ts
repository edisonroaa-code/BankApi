import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager, In, Like } from 'typeorm';
import { UserRole } from '../users/entities/user.entity';
import { AuditLog } from './entities/audit-log.entity';

export const PRINT_OPEN_ACTIONS = ['PAYMENT_PRINT_OPENED', 'BANK_TRANSFER_RECEIPT_PRINT_OPENED'];
type PrintActor = { userId: string; username?: string; role?: string };
export type PrintTarget = {
  scopeKey: string;
  paymentId?: string | null;
  bankTransferId?: string | null;
  claimId?: string;
  receiptNumber?: string;
  openAction: string;
  printAction: string;
};
export type PrintAuthorization = { authorizationId: string; scopeKey: string; copyNumber: number; reprintReason: string | null };
export const printMetadata = (log: Pick<AuditLog, 'metadata'>): Record<string, any> => {
  try { return JSON.parse(log.metadata || '{}'); } catch { return {}; }
};

const resource = (target: PrintTarget) => target.paymentId ? { paymentId: target.paymentId } : { bankTransferId: target.bankTransferId! };

/** El llamador mantiene bloqueado el pago o la toma durante apertura y confirmación. */
export async function authorizePrint(
  manager: EntityManager, target: PrintTarget, actor: PrintActor, printedCopies: number, reason?: string,
): Promise<PrintAuthorization> {
  // Un impreso histórico basta para denegar antes de consultar aperturas.
  if (printedCopies > 0 && actor.role !== UserRole.ADMIN) throw new ForbiddenException('Solo ADMIN puede reimprimir tickets. Solicitá la reimpresión a administración.');
  const repo = manager.getRepository(AuditLog);
  const history = await repo.find({ where: { ...resource(target), action: In(PRINT_OPEN_ACTIONS) } });
  const prior = history.filter((log) => {
    const m = printMetadata(log);
    if (m.scopeKey) return m.scopeKey === target.scopeKey || (!!target.claimId && m.claimId === target.claimId);
    return log.action === 'PAYMENT_PRINT_OPENED' || (!!target.receiptNumber && m.receiptNumber === target.receiptNumber);
  });
  const isReprint = printedCopies > 0 || prior.length > 0;
  if (isReprint && actor.role !== UserRole.ADMIN) throw new ForbiddenException('El ticket ya fue emitido. Solo ADMIN puede volver a imprimirlo, incluso si la primera apertura no se confirmó.');
  const reprintReason = reason?.trim() || null;
  if (isReprint && (!reprintReason || reprintReason.length < 10 || reprintReason.length > 500)) {
    throw new BadRequestException('Para reimprimir, ADMIN debe indicar un motivo de entre 10 y 500 caracteres.');
  }
  const grant: PrintAuthorization = {
    authorizationId: randomUUID(), scopeKey: target.scopeKey,
    copyNumber: Math.max(printedCopies, ...prior.map((log) => Number(printMetadata(log).copyNumber || printMetadata(log).copy || 1))) + 1,
    reprintReason: isReprint ? reprintReason : null,
  };
  await repo.save(repo.create({
    action: target.openAction, userId: actor.userId, actorUsername: actor.username ?? null,
    paymentId: target.paymentId ?? null, bankTransferId: target.bankTransferId ?? null,
    metadata: JSON.stringify({ ...grant, claimId: target.claimId, receiptNumber: target.receiptNumber }),
  }));
  return grant;
}

export async function checkPrintAuthorization(
  manager: EntityManager, target: PrintTarget, actor: PrintActor, authorizationId?: string, allowedScopes = [target.scopeKey],
): Promise<PrintAuthorization & { confirmed: boolean }> {
  if (!authorizationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(authorizationId)) {
    throw new BadRequestException('Volvé a abrir el ticket desde la versión actualizada para confirmar su impresión.');
  }
  const repo = manager.getRepository(AuditLog);
  const matchId = Like(`%"authorizationId":"${authorizationId}"%`);
  // Cada vía confirma únicamente sus propias aperturas, siempre ligadas al recurso y al usuario.
  const where = target.bankTransferId ? { bankTransferId: target.bankTransferId } : { paymentId: target.paymentId! };
  const opened = await repo.findOne({ where: { ...where, action: target.openAction, metadata: matchId } });
  const m = opened ? printMetadata(opened) : {};
  if (!opened || opened.userId !== actor.userId || m.authorizationId !== authorizationId || !allowedScopes.includes(m.scopeKey) ||
      (target.claimId && m.claimId !== target.claimId) || (m.reprintReason && actor.role !== UserRole.ADMIN)) {
    throw new ForbiddenException('Esta autorización de impresión no corresponde al usuario o al ticket.');
  }
  const confirmed = !!await repo.findOne({ where: { ...where, action: target.printAction, metadata: matchId } });
  return { authorizationId, scopeKey: m.scopeKey, copyNumber: m.copyNumber, reprintReason: m.reprintReason, confirmed };
}
