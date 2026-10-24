import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, MoreThanOrEqual, Not, QueryFailedError, SelectQueryBuilder } from 'typeorm';
import { AuditLog } from '../payments/entities/audit-log.entity';
import { Payment, PaymentState } from '../payments/entities/payment.entity';
import { PaymentsGateway } from '../payments/payments.gateway';
import { ROOMS, seesFullSenderData } from '../payments/realtime-rooms';
import { User, UserRole } from '../users/entities/user.entity';
import { BANK_FEED_CONFIG } from './bank.constants';
import { localDateKey } from './bank-feed.config';
import type { BankFeedConfig } from './bank-feed.config';
import { cents, formatMoney, fromCents, remainingCents, resolveAmountToClaim, statusFromAllocation } from './bank-allocation';
import { assessMatch, MatchAssessment, senderAccountKey } from './bank-match';
import { maskIdentifier, normalizeReference, NormalizedCredit, senderBankFromInfo } from './bank-credit';
import { BankTransfer, BankTransferSource, BankTransferStatus } from './entities/bank-transfer.entity';
import { BankTransferClaim, ClaimReferenceType, ClaimStatus } from './entities/bank-transfer-claim.entity';
import { authorizePrint, checkPrintAuthorization, printMetadata, PrintTarget } from '../payments/print-authorization';

export type Actor = { userId: string; username?: string; name?: string; role: string };

export type BankClaimDto = {
  printIssued?: boolean;
  id: string;
  receiptNumber: string;
  amount: number;
  referenceType: ClaimReferenceType;
  referenceValue: string;
  note: string | null;
  claimedById: string;
  claimedByName: string | null;
  claimedByUsername: string | null;
  claimedByRole: string;
  claimedAt: Date;
  status: ClaimStatus;
  printCount: number;
  paymentId: string | null;
  paymentRef: string | null;
  clientName: string | null;
  clientCode: string | null;
  collectorName: string | null;
  matchStrength: string | null;
  matchEvidence: string | null;
  voidedByName?: string | null;
  voidedAt?: Date | null;
  voidReason?: string | null;
};

export type BankTransferDto = {
  id: string;
  source: string;
  bankDocNumber: string | null;
  amount: number;
  /** Suma de las tomas activas. */
  allocatedAmount: number;
  /** Lo que todavia se puede tomar. */
  availableAmount: number;
  currency: string;
  movementAt: Date;
  concept: string;
  senderName: string | null;
  senderDoc: string | null;
  senderAccount: string | null;
  senderNote: string | null;
  senderBankCode: string | null;
  senderBankName: string | null;
  channel: string | null;
  sipapReference: string | null;
  sipapReason: string | null;
  txDescription: string | null;
  status: BankTransferStatus;
  reversedAt: Date | null;
  blockedReason: string | null;
  firstSeenAt: Date;
  /** Tomas activas, de la mas reciente a la mas vieja. Vacio si nadie la tomo. */
  claims: BankClaimDto[];
};

export type BankReceiptDto = {
  printAuthorizationId?: string;
  printScope?: 'PAYMENT' | 'CLAIM';
  printCopyNumber?: number;
  reprintReason?: string | null;
  /** Para confirmar la impresion despues del dialogo sin volver a buscar la toma. */
  transferId: string;
  claimId: string;
  receiptNumber: string;
  source: BankTransferSource;
  claimedAt: Date;
  claimedByName: string | null;
  claimedByUsername: string | null;
  claimedByRole: string;
  referenceType: ClaimReferenceType;
  referenceValue: string;
  paymentRef: string | null;
  /** Consulta conciliada (null en una toma de caja): la pantalla la actualiza al confirmar la impresion. */
  paymentId: string | null;
  /** Datos de la consulta conciliada, tal como los cargo el cobrador. */
  clientName: string | null;
  clientCode: string | null;
  collectorName: string | null;
  /** Monto tomado por este comprobante. */
  amount: number;
  /** Monto total de la transferencia, para que se vea si fue una toma parcial. */
  transferAmount: number;
  currency: string;
  senderName: string | null;
  bankDocNumber: string | null;
  movementAt: Date;
  printCount: number;
  voided: boolean;
};

export type CandidatePaymentDto = {
  id: string;
  paymentRef: string | null;
  clientName: string | null;
  clientCode: string | null;
  sourceBank: string | null;
  isAtlasAccount: boolean | null;
  amount: number;
  allocatedAmount: number;
  pendingAmount: number;
  status: PaymentState;
  createdAt: Date;
  collectorName: string | null;
  collectorId: string;
  match?: MatchAssessment;
};

/** Pestañas del panel: que estados entran en cada una. */
export type BankListView = 'DISPONIBLES' | 'TOMADAS' | 'REVISAR' | 'TODAS';
const VIEW_STATUSES: Record<BankListView, BankTransferStatus[] | null> = {
  // Con saldo para tomar: las parciales todavia tienen una parte libre.
  DISPONIBLES: [BankTransferStatus.DISPONIBLE, BankTransferStatus.PARCIAL],
  TOMADAS: [BankTransferStatus.TOMADA, BankTransferStatus.PARCIAL],
  REVISAR: [BankTransferStatus.REVERSADA, BankTransferStatus.BLOQUEADA],
  TODAS: null,
};

export type BankTransfersPage = {
  month: string;
  view: BankListView;
  items: BankTransferDto[];
  total: number;
  page: number;
  pageSize: number;
  /** Cantidad por pestaña en el mes (sin la busqueda). */
  counts: Record<BankListView, number>;
  /** Transferencias sin tomar de otros meses: no deben quedar fuera de la vista. */
  pendingOtherMonths: Array<{ month: string; count: number }>;
};

type PaymentInfo = { paymentRef: string | null; clientName: string | null; clientCode: string | null; collectorName: string | null; printedAt?: Date | null };

/** Auditoria de "el admin reviso esta conciliacion y esta bien": la saca de la cola sin anular nada. */
const CLAIM_REVIEWED = 'BANK_CLAIM_REVIEWED';

const referenceLabel = (type: ClaimReferenceType) =>
  type === ClaimReferenceType.TICKET ? 'ticket' : type === ClaimReferenceType.CLIENTE ? 'cliente' : 'consulta';

const roleLabel = (role: string) =>
  role === UserRole.CAJERO ? 'caja' : role === UserRole.COBRADOR ? 'cobrador' : role === UserRole.ADMIN ? 'admin' : 'supervisor';

const DECIDABLE_PAYMENT_STATES = [PaymentState.PENDIENTE_VERIFICACION, PaymentState.EN_REVISION];
const currencyIso = (value: unknown) => typeof value === 'string' ? value.trim().toUpperCase() : '';

@Injectable()
export class BankTransfersService {
  private readonly logger = new Logger(BankTransfersService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly gateway: PaymentsGateway,
    @Inject(BANK_FEED_CONFIG) private readonly config: BankFeedConfig,
  ) {}

  // ---------------------------------------------------------------- DTOs

  private toClaimDto(claim: BankTransferClaim, info?: PaymentInfo): BankClaimDto {
    return {
      id: claim.id,
      receiptNumber: claim.receiptNumber,
      amount: Number(claim.amount),
      referenceType: claim.referenceType,
      referenceValue: claim.referenceValue,
      note: claim.note,
      claimedById: claim.claimedById,
      claimedByName: claim.claimedByName,
      claimedByUsername: claim.claimedByUsername,
      claimedByRole: claim.claimedByRole,
      claimedAt: claim.claimedAt,
      status: claim.status,
      printCount: claim.printCount,
      printIssued: claim.printCount > 0 || !!info?.printedAt || !!(claim as BankTransferClaim & { printIssued?: boolean }).printIssued,
      paymentId: claim.paymentId,
      paymentRef: info?.paymentRef ?? null,
      clientName: info?.clientName ?? null,
      clientCode: info?.clientCode ?? null,
      collectorName: info?.collectorName ?? null,
      matchStrength: claim.matchStrength,
      matchEvidence: claim.matchEvidence,
      voidedByName: claim.voidedByName,
      voidedAt: claim.voidedAt,
      voidReason: claim.voidReason,
    };
  }

  toDto(
    transfer: BankTransfer,
    claims: BankTransferClaim[],
    fullSenderData: boolean,
    infos?: Map<string, PaymentInfo>,
  ): BankTransferDto {
    // Las registradas antes del 13/10 no copiaron el banco de origen a sus columnas, pero lo tienen
    // en el movimiento original guardado: se lee de ahi, sin reescribir la base.
    const fromRaw = senderBankFromInfo((transfer.rawPayload as { infoAdicional?: Record<string, unknown> } | undefined)?.infoAdicional);
    return {
      id: transfer.id,
      source: transfer.source,
      bankDocNumber: transfer.bankDocNumber,
      amount: Number(transfer.amount),
      allocatedAmount: Number(transfer.allocatedAmount ?? 0),
      availableAmount: fromCents(Math.max(0, remainingCents(transfer))),
      currency: transfer.currency,
      movementAt: transfer.movementAt,
      concept: transfer.concept,
      senderName: transfer.senderName,
      senderDoc: fullSenderData ? transfer.senderDoc : maskIdentifier(transfer.senderDoc),
      senderAccount: fullSenderData ? transfer.senderAccount : maskIdentifier(transfer.senderAccount),
      senderNote: transfer.senderNote,
      senderBankCode: transfer.senderBankCode ?? fromRaw.senderBankCode,
      senderBankName: transfer.senderBankName ?? fromRaw.senderBankName,
      channel: transfer.channel,
      sipapReference: transfer.sipapReference ?? fromRaw.sipapReference,
      sipapReason: transfer.sipapReason,
      txDescription: transfer.txDescription,
      status: transfer.status,
      reversedAt: transfer.reversedAt,
      blockedReason: transfer.blockedReason,
      firstSeenAt: transfer.firstSeenAt,
      claims: claims.map((c) => this.toClaimDto(c, c.paymentId ? infos?.get(c.paymentId) : undefined)),
    };
  }

  private toReceipt(transfer: BankTransfer, claim: BankTransferClaim, info?: PaymentInfo): BankReceiptDto {
    return {
      transferId: transfer.id,
      claimId: claim.id,
      receiptNumber: claim.receiptNumber,
      source: transfer.source,
      claimedAt: claim.claimedAt,
      claimedByName: claim.claimedByName,
      claimedByUsername: claim.claimedByUsername,
      claimedByRole: claim.claimedByRole,
      referenceType: claim.referenceType,
      referenceValue: claim.referenceValue,
      paymentRef: info?.paymentRef ?? null,
      paymentId: claim.paymentId ?? null,
      clientName: info?.clientName ?? null,
      clientCode: info?.clientCode ?? null,
      collectorName: info?.collectorName ?? null,
      amount: Number(claim.amount),
      transferAmount: Number(transfer.amount),
      currency: transfer.currency,
      senderName: transfer.senderName,
      bankDocNumber: transfer.bankDocNumber,
      movementAt: transfer.movementAt,
      printCount: claim.printCount,
      voided: claim.status === ClaimStatus.ANULADA,
    };
  }

  private async paymentInfos(manager: EntityManager, paymentIds: (string | null | undefined)[]): Promise<Map<string, PaymentInfo>> {
    const ids = Array.from(new Set(paymentIds.filter((v): v is string => !!v)));
    if (ids.length === 0) return new Map();
    const payments = await manager.getRepository(Payment).find({ where: { id: In(ids) }, relations: ['createdBy'] });
    return new Map(
      payments.map((p) => [
        p.id,
        {
          paymentRef: p.paymentRef ?? null,
          clientName: p.clientName ?? null,
          clientCode: p.clientCode ?? null,
          collectorName: p.createdBy?.name || p.createdBy?.username || null,
          printedAt: p.printedAt,
        },
      ]),
    );
  }

  /** Tomas activas de varias transferencias, agrupadas por transferencia. */
  private async activeClaimsFor(manager: EntityManager, transferIds: string[]): Promise<Map<string, BankTransferClaim[]>> {
    const grouped = new Map<string, BankTransferClaim[]>();
    if (transferIds.length === 0) return grouped;
    const claims = await manager.getRepository(BankTransferClaim).find({
      where: { bankTransferId: In(transferIds), status: ClaimStatus.ACTIVA },
      order: { claimedAt: 'DESC' },
    });
    await this.flagIssuedClaims(manager, claims);
    for (const claim of claims) {
      const list = grouped.get(claim.bankTransferId) ?? [];
      list.push(claim);
      grouped.set(claim.bankTransferId, list);
    }
    return grouped;
  }

  private async flagIssuedClaims(manager: EntityManager, claims: BankTransferClaim[]) {
    if (!claims.length) return;
    const ids = [...new Set(claims.map((c) => c.bankTransferId))];
    const logs = await manager.getRepository(AuditLog).find({ where: { bankTransferId: In(ids), action: 'BANK_TRANSFER_RECEIPT_PRINT_OPENED' } });
    for (const claim of claims) Object.assign(claim, { printIssued: claim.printCount > 0 || logs.some((log) => {
      const m = printMetadata(log);
      return log.bankTransferId === claim.bankTransferId && (m.claimId === claim.id || m.receiptNumber === claim.receiptNumber);
    }) });
  }

  /** Envia el estado actualizado a cada sala con el nivel de detalle que le corresponde. */
  async broadcast(transfer: BankTransfer, event: 'bank-transfers:new' | 'bank-transfers:updated') {
    const manager = this.dataSource.manager;
    const claims = (await this.activeClaimsFor(manager, [transfer.id])).get(transfer.id) ?? [];
    const infos = await this.paymentInfos(manager, claims.map((c) => c.paymentId));
    this.gateway.emitToRoom(ROOMS.bankFull, event, this.toDto(transfer, claims, true, infos));
    this.gateway.emitToRoom(ROOMS.bankMasked, event, this.toDto(transfer, claims, false, infos));
  }

  private async audit(manager: EntityManager, entry: Partial<AuditLog>) {
    const repo = manager.getRepository(AuditLog);
    await repo.save(repo.create({ userId: 'system', ...entry }));
  }

  private actorAudit(actor: Actor) {
    return { userId: actor.userId, actorUsername: actor.username ?? null };
  }

  private async resolveName(manager: EntityManager, actor: Actor) {
    return actor.name ?? (await manager.getRepository(User).findOneBy({ id: actor.userId }))?.name ?? null;
  }

  private async nextReceiptNumber(manager: EntityManager) {
    const rows = await manager.query(`SELECT nextval('bank_transfer_receipt_seq') AS n`);
    return `TR-${String(rows[0].n).padStart(6, '0')}`;
  }

  /** Mes local "YYYY-MM" (por defecto el actual) como rango de instantes. */
  private monthRange(month?: string) {
    const key = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : localDateKey(new Date(), this.config.tzOffsetMinutes).slice(0, 7);
    const [year, mon] = key.split('-').map(Number);
    const from = new Date(`${key}-01T00:00:00${this.config.tzOffset}`);
    const nextKey = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, '0')}`;
    const to = new Date(`${nextKey}-01T00:00:00${this.config.tzOffset}`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new BadRequestException('Mes invalido.');
    return { key, from, to };
  }

  private dayRange(date?: string) {
    const key = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localDateKey(new Date(), this.config.tzOffsetMinutes);
    const from = new Date(`${key}T00:00:00${this.config.tzOffset}`);
    if (Number.isNaN(from.getTime())) throw new BadRequestException('Fecha invalida.');
    return { key, from, to: new Date(from.getTime() + 24 * 60 * 60 * 1000) };
  }

  private isUniqueViolation(error: unknown) {
    return error instanceof QueryFailedError && (error as any).driverError?.code === '23505';
  }

  /** 23514: la base rechazo la toma porque el saldo no alcanzaba. Es la red de seguridad final. */
  private isCheckViolation(error: unknown) {
    return error instanceof QueryFailedError && (error as any).driverError?.code === '23514';
  }

  /**
   * Cliente único que esa cuenta del mismo banco pagó antes, según conciliaciones activas.
   * Una cuenta que paga a varios clientes no identifica a uno por ser el más frecuente.
   */
  private async knownClientsByAccount(manager: EntityManager, accounts: (string | null)[]): Promise<Map<string, string>> {
    const list = Array.from(new Set(accounts.filter((v): v is string => !!v)));
    if (list.length === 0) return new Map();
    const rows: { account: string; bank: string | null; code: string }[] = await manager.query(
      `SELECT t."senderAccount" AS account, p."clientCode" AS code,
              COALESCE(t."senderBankName", t."rawPayload"->'infoAdicional'->>'des_swi_ban_remitente') AS bank
         FROM "bank_transfer_claims" c
         JOIN "bank_transfers" t ON t."id" = c."bankTransferId"
         JOIN "payments" p ON p."id" = c."paymentId"
        WHERE c."status" = 'ACTIVA' AND p."clientCode" IS NOT NULL AND t."senderAccount" = ANY($1)
        GROUP BY 1, 2, 3`,
      [list],
    );
    const clients = new Map<string, Set<string>>();
    for (const row of rows) {
      const identity = senderAccountKey({ senderAccount: row.account, senderBankName: row.bank });
      if (!identity || !row.code.trim()) continue;
      const codes = clients.get(identity) ?? new Set<string>();
      codes.add(normalizeReference(row.code));
      clients.set(identity, codes);
    }
    return new Map([...clients].filter(([, codes]) => codes.size === 1).map(([identity, codes]) => [identity, [...codes][0]]));
  }

  // ------------------------------------------------------- registro (feed)

  /**
   * Registra un credito visto en el banco. Idempotente por huella: el mismo movimiento
   * nunca crea dos filas. Detecta reversas y posibles duplicados con huella distinta.
   */
  async registerCredit(credit: NormalizedCredit): Promise<{ transfer: BankTransfer; created: boolean; reversedNow: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(BankTransfer);
      const now = new Date();
      const { fingerprint, reversed, ...fields } = credit;

      const insert = await repo
        .createQueryBuilder()
        .insert()
        .into(BankTransfer)
        .values({
          ...fields,
          fingerprint,
          status: reversed ? BankTransferStatus.REVERSADA : BankTransferStatus.DISPONIBLE,
          reversedAt: reversed ? now : null,
          lastSeenAt: now,
          rawPayload: fields.rawPayload as any,
        })
        .orIgnore()
        .returning(['id'])
        .execute();
      const createdId: string | undefined = insert.raw?.[0]?.id;

      if (createdId) {
        const transfer = await repo.findOneByOrFail({ id: createdId });
        if (!reversed && transfer.bankDocNumber) {
          const since = new Date(transfer.movementAt.getTime() - 3 * 24 * 60 * 60 * 1000);
          const twin = await repo
            .createQueryBuilder('t')
            .where('t.accountNumber = :account AND t.bankDocNumber = :doc AND t.amount = :amount AND t.id <> :id', {
              account: transfer.accountNumber,
              doc: transfer.bankDocNumber,
              amount: transfer.amount,
              id: transfer.id,
            })
            .andWhere('t.movementAt >= :since', { since })
            .getOne();
          if (twin) {
            // Mismo documento y monto con huella distinta: no se habilita hasta que el admin lo revise.
            transfer.status = BankTransferStatus.BLOQUEADA;
            transfer.blockedReason = `Posible duplicado del documento ${transfer.bankDocNumber} (${twin.id}).`;
            await repo.save(transfer);
            await this.audit(manager, {
              action: 'BANK_TRANSFER_BLOCKED',
              bankTransferId: transfer.id,
              metadata: JSON.stringify({ reason: transfer.blockedReason, twinId: twin.id }),
            });
          }
        }
        return { transfer, created: true, reversedNow: false };
      }

      const existing = await repo.findOne({ where: { fingerprint }, lock: { mode: 'pessimistic_write' } });
      if (!existing) throw new Error(`Transferencia con huella ${fingerprint} no encontrada tras conflicto.`);
      if (reversed && !existing.reversedAt) {
        const activeClaims = await manager
          .getRepository(BankTransferClaim)
          .count({ where: { bankTransferId: existing.id, status: ClaimStatus.ACTIVA } });
        existing.status = BankTransferStatus.REVERSADA;
        existing.reversedAt = now;
        existing.lastSeenAt = now;
        await repo.save(existing);
        await this.audit(manager, {
          action: 'BANK_TRANSFER_REVERSED',
          bankTransferId: existing.id,
          // Una reversa sobre dinero ya tomado es lo mas grave que puede pasar: queda contado.
          metadata: JSON.stringify({ activeClaims, allocatedAmount: Number(existing.allocatedAmount ?? 0) }),
        });
        return { transfer: existing, created: false, reversedNow: true };
      }
      return { transfer: existing, created: false, reversedNow: false };
    });
  }

  // ------------------------------------------- banco de origen (SIPAP)

  async pendingSenderBank(ids: string[]) {
    if (ids.length === 0) return [];
    return this.dataSource.getRepository(BankTransfer).find({ where: { id: In(ids), senderBankCode: IsNull() } });
  }

  async usedSipapReferences(since: Date): Promise<Set<string>> {
    const rows = await this.dataSource.getRepository(BankTransfer).find({
      select: ['sipapReference'],
      where: { sipapReference: Not(IsNull()), movementAt: MoreThanOrEqual(since) },
    });
    return new Set(rows.map((r) => r.sipapReference!).filter(Boolean));
  }

  /** Completa el banco de origen sin tocar estado ni tomas; solo si todavia no estaba informado. */
  async applySenderBank(
    id: string,
    info: { senderBankCode: string | null; senderBankName: string | null; channel: string | null; sipapReference: string | null; sipapReason: string | null },
  ): Promise<BankTransfer | null> {
    const result = await this.dataSource
      .createQueryBuilder()
      .update(BankTransfer)
      .set({ ...info, enrichedAt: new Date() })
      .where('id = :id AND "senderBankCode" IS NULL', { id })
      .execute();
    if (!result.affected) return null;
    const transfer = await this.dataSource.getRepository(BankTransfer).findOneByOrFail({ id });
    await this.broadcast(transfer, 'bank-transfers:updated');
    return transfer;
  }

  // ------------------------------------------------------------- lectura

  async list(query: { date?: string; status?: BankTransferStatus; search?: string }, actor: Actor): Promise<BankTransferDto[]> {
    const { from, to } = this.dayRange(query.date);
    const qb = this.dataSource
      .getRepository(BankTransfer)
      .createQueryBuilder('t')
      .where('t.movementAt >= :from AND t.movementAt < :to', { from, to })
      .orderBy('t.movementAt', 'DESC')
      .take(500);

    if (query.status) qb.andWhere('t.status = :status', { status: query.status });
    this.applySearch(qb, query.search);
    return this.toDtos(await qb.getMany(), actor);
  }

  /** Busca por monto, documento, nota, remitente, concepto o referencia de una toma activa. */
  private applySearch(qb: SelectQueryBuilder<BankTransfer>, raw?: string) {
    const search = raw?.trim();
    if (!search) return;
    // La busqueda por toma va por EXISTS: una transferencia puede tener varias y no debe duplicarse.
    const claimMatch = `EXISTS (SELECT 1 FROM "bank_transfer_claims" c WHERE c."bankTransferId" = t."id" AND c."status" = 'ACTIVA' AND (%s))`;
    const digits = search.replace(/[.\s]/g, '');
    if (/^\d+$/.test(digits)) {
      qb.andWhere(
        `(t.amount = :amount OR t."bankDocNumber" = :digits OR t."senderNote" ILIKE :like OR ${claimMatch.replace('%s', `c."referenceValue" = :ref`)})`,
        { amount: Number(digits), digits, ref: normalizeReference(digits), like: `%${digits}%` },
      );
    } else {
      qb.andWhere(
        `(t."senderName" ILIKE :like OR t."senderNote" ILIKE :like OR t.concept ILIKE :like OR t."senderBankName" ILIKE :like OR ${claimMatch.replace(
          '%s',
          `(c."claimedByName" ILIKE :like OR c."referenceValue" ILIKE :like)`,
        )})`,
        { like: `%${search}%` },
      );
    }
  }

  private async toDtos(rows: BankTransfer[], actor: Actor) {
    const claimsByTransfer = await this.activeClaimsFor(this.dataSource.manager, rows.map((r) => r.id));
    const infos = await this.paymentInfos(
      this.dataSource.manager,
      [...claimsByTransfer.values()].flat().map((c) => c.paymentId),
    );
    const full = seesFullSenderData(actor.role);
    return rows.map((r) => this.toDto(r, claimsByTransfer.get(r.id) ?? [], full, infos));
  }

  /**
   * Panel por mes, paginado. Lo que entro ayer y nadie tomo sigue a la vista hoy: la vista es el
   * mes, no el dia, y lo pendiente de meses anteriores se informa aparte para no perderlo.
   */
  async listPage(
    query: { month?: string; view?: BankListView; page?: number; pageSize?: number; search?: string },
    actor: Actor,
  ): Promise<BankTransfersPage> {
    const { key: month, from, to } = this.monthRange(query.month);
    const view: BankListView = query.view && query.view in VIEW_STATUSES ? query.view : 'TODAS';
    const pageSize = Math.min(200, Math.max(1, Math.floor(query.pageSize ?? 25)));
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const repo = this.dataSource.getRepository(BankTransfer);
    const inMonth = () => repo.createQueryBuilder('t').where('t.movementAt >= :from AND t.movementAt < :to', { from, to });

    const qb = inMonth();
    const statuses = VIEW_STATUSES[view];
    if (statuses) qb.andWhere('t.status IN (:...statuses)', { statuses });
    this.applySearch(qb, query.search);
    // El id desempata dos transferencias de la misma hora: ninguna se repite ni se pierde entre paginas.
    qb.orderBy('t.movementAt', 'DESC').addOrderBy('t.id', 'DESC').skip((page - 1) * pageSize).take(pageSize);

    const open = VIEW_STATUSES.DISPONIBLES!;
    const [[rows, total], byStatus, pendingElsewhere] = await Promise.all([
      qb.getManyAndCount(),
      inMonth().select('t.status', 'status').addSelect('COUNT(*)', 'n').groupBy('t.status').getRawMany<{ status: BankTransferStatus; n: string }>(),
      repo
        .createQueryBuilder('t')
        .select('t.movementAt', 'movementAt')
        .where('t.status IN (:...open)', { open })
        .andWhere('(t.movementAt < :from OR t.movementAt >= :to)', { from, to })
        .orderBy('t.movementAt', 'DESC')
        .limit(1000)
        .getRawMany<{ movementAt: Date }>(),
    ]);

    const n = (list: BankTransferStatus[] | null) =>
      byStatus.filter((r) => !list || list.includes(r.status)).reduce((sum, r) => sum + Number(r.n), 0);
    const pendingByMonth = new Map<string, number>();
    for (const r of pendingElsewhere) {
      const key = localDateKey(new Date(r.movementAt), this.config.tzOffsetMinutes).slice(0, 7);
      pendingByMonth.set(key, (pendingByMonth.get(key) ?? 0) + 1);
    }

    return {
      month,
      view,
      items: await this.toDtos(rows, actor),
      total,
      page,
      pageSize,
      counts: { DISPONIBLES: n(VIEW_STATUSES.DISPONIBLES), TOMADAS: n(VIEW_STATUSES.TOMADAS), REVISAR: n(VIEW_STATUSES.REVISAR), TODAS: n(null) },
      pendingOtherMonths: [...pendingByMonth].map(([key, count]) => ({ month: key, count })).sort((a, b) => b.month.localeCompare(a.month)),
    };
  }

  async getOne(id: string, actor: Actor): Promise<BankTransferDto> {
    const transfer = await this.dataSource.getRepository(BankTransfer).findOne({ where: { id } });
    if (!transfer) throw new NotFoundException('Transferencia no encontrada.');
    const claims = (await this.activeClaimsFor(this.dataSource.manager, [id])).get(id) ?? [];
    const infos = await this.paymentInfos(this.dataSource.manager, claims.map((c) => c.paymentId));
    return this.toDto(transfer, claims, seesFullSenderData(actor.role), infos);
  }

  async history(id: string) {
    const transfer = await this.dataSource.getRepository(BankTransfer).findOne({ where: { id } });
    if (!transfer) throw new NotFoundException('Transferencia no encontrada.');
    const claims = await this.dataSource.getRepository(BankTransferClaim).find({
      where: { bankTransferId: id },
      order: { claimedAt: 'DESC' },
    });
    const infos = await this.paymentInfos(this.dataSource.manager, claims.map((c) => c.paymentId));
    const audit = await this.dataSource.getRepository(AuditLog).find({
      where: { bankTransferId: id },
      order: { timestamp: 'DESC' },
      take: 200,
    });
    return {
      transfer: this.toDto(transfer, claims.filter((c) => c.status === ClaimStatus.ACTIVA), true, infos),
      rawPayload: transfer.rawPayload,
      claims: claims.map((c) => this.toClaimDto(c, c.paymentId ? infos.get(c.paymentId) : undefined)),
      audit,
    };
  }

  async myClaims(actor: Actor, date?: string, month?: string): Promise<BankTransferDto[]> {
    const { from, to } = month ? this.monthRange(month) : this.dayRange(date);
    const claims = await this.dataSource
      .getRepository(BankTransferClaim)
      .createQueryBuilder('c')
      .innerJoinAndSelect('c.bankTransfer', 't')
      .where('c.claimedById = :uid', { uid: actor.userId })
      .andWhere('c.claimedAt >= :from AND c.claimedAt < :to', { from, to })
      .orderBy('c.claimedAt', 'DESC')
      .getMany();
    await this.flagIssuedClaims(this.dataSource.manager, claims);
    const infos = await this.paymentInfos(this.dataSource.manager, claims.map((c) => c.paymentId));
    const full = seesFullSenderData(actor.role);
    return claims.map((c) => this.toDto(c.bankTransfer!, [c], full, infos));
  }

  /**
   * Transferencias candidatas para una consulta, ordenadas por evidencia. Sirve para conciliar y,
   * cuando la transferencia ya esta tomada, como alerta de doble uso.
   */
  async matchesForPayment(paymentId: string, actor?: Actor): Promise<(BankTransferDto & { match: MatchAssessment })[]> {
    const payment = await this.dataSource.getRepository(Payment).findOne({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Consulta no encontrada.');
    if (actor?.role === UserRole.COBRADOR && payment.createdById !== actor.userId) {
      throw new ForbiddenException('Solo podés ver coincidencias de tus propias consultas.');
    }
    // El feed es de la cuenta Atlas. BNF se revisa por su propio comprobante.
    if (payment.isAtlasAccount === false) return [];
    const created = new Date(payment.createdAt);
    const query = this.dataSource
      .getRepository(BankTransfer)
      .createQueryBuilder('t')
      .where('t.movementAt BETWEEN :from AND :to', {
        from: new Date(created.getTime() - 5 * 24 * 60 * 60 * 1000),
        to: new Date(created.getTime() + 2 * 24 * 60 * 60 * 1000),
      });

    const ranked = await this.rankCandidates(query, 'movementAt', async (rows) => {
      const known = await this.knownClientsByAccount(this.dataSource.manager, rows.map((r) => r.senderAccount));
      return rows.map((row) => ({ row, match: assessMatch(row, payment, known.get(senderAccountKey(row))) }));
    });
    const rows = ranked.map((item) => item.row);

    const claimsByTransfer = await this.activeClaimsFor(this.dataSource.manager, rows.map((r) => r.id));
    const infos = await this.paymentInfos(this.dataSource.manager, [...claimsByTransfer.values()].flat().map((c) => c.paymentId));
    const full = actor ? seesFullSenderData(actor.role) : true;

    return ranked.map(({ row, match }) => ({
      ...this.toDto(row, claimsByTransfer.get(row.id) ?? [], full, infos), match,
    }));
  }

  /** Consultas candidatas para una transferencia, ordenadas por evidencia. */
  async candidatePayments(id: string, actor?: Actor): Promise<CandidatePaymentDto[]> {
    const transfer = await this.dataSource.getRepository(BankTransfer).findOne({ where: { id } });
    if (!transfer) throw new NotFoundException('Transferencia no encontrada.');
    const movementAt = new Date(transfer.movementAt);
    const qb = this.dataSource
      .getRepository(Payment)
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.createdBy', 'createdBy')
      .where('p.status IN (:...statuses)', { statuses: DECIDABLE_PAYMENT_STATES })
      .andWhere('p."isAtlasAccount" = true')
      .andWhere('p."allocatedAmount" < p.amount')
      .andWhere('p.createdAt BETWEEN :from AND :to', {
        from: new Date(movementAt.getTime() - 2 * 24 * 60 * 60 * 1000),
        to: new Date(movementAt.getTime() + 5 * 24 * 60 * 60 * 1000),
      });
    // Un cobrador solo concilia lo suyo: no tiene por que ver candidatas de otros desde aca.
    if (actor?.role === UserRole.COBRADOR) qb.andWhere('p."createdById" = :uid', { uid: actor.userId });

    const known = transfer.senderAccount
      ? (await this.knownClientsByAccount(this.dataSource.manager, [transfer.senderAccount])).get(senderAccountKey(transfer))
      : undefined;

    const ranked = await this.rankCandidates(qb, 'createdAt', async (rows) => rows.map((row) => ({ row, match: assessMatch(transfer, row, known) })));
    return ranked
      .map(({ row: p, match }) => ({
        id: p.id,
        paymentRef: p.paymentRef ?? null,
        clientName: p.clientName ?? null,
        clientCode: p.clientCode ?? null,
        sourceBank: p.sourceBank ?? null,
        isAtlasAccount: p.isAtlasAccount ?? null,
        amount: Number(p.amount),
        allocatedAmount: Number(p.allocatedAmount ?? 0),
        pendingAmount: fromCents(Math.max(0, remainingCents(p))),
        status: p.status,
        createdAt: p.createdAt,
        collectorName: p.createdBy?.name || p.createdBy?.username || null,
        collectorId: p.createdById,
        match,
      }));
  }

  /** Recorre la ventana de fechas en lotes; el límite se aplica después de evaluar la evidencia. */
  private async rankCandidates<T extends BankTransfer | Payment>(
    query: SelectQueryBuilder<T>,
    timeColumn: 'movementAt' | 'createdAt',
    assess: (rows: T[]) => Promise<{ row: T; match: MatchAssessment }[]>,
  ): Promise<{ row: T; match: MatchAssessment }[]> {
    const batchSize = 500;
    let best: { row: T; match: MatchAssessment }[] = [];
    let cursor: string | undefined;
    for (;;) {
      // Pagina por UUID para no perder precisión de microsegundos al convertir fechas de PG.
      const batch = query.clone().orderBy(`${query.alias}.id`, 'ASC').take(batchSize);
      if (cursor) batch.andWhere(`${query.alias}.id > :cursorId`, { cursorId: cursor });
      const rows = await batch.getMany();
      const time = (row: T) => new Date(timeColumn === 'movementAt' ? (row as BankTransfer).movementAt : (row as Payment).createdAt).getTime();
      best = [...best, ...await assess(rows)].sort((a, b) => b.match.score - a.match.score || time(b.row) - time(a.row) || a.row.id.localeCompare(b.row.id)).slice(0, 20);
      if (rows.length < batchSize) return best;
      cursor = rows[rows.length - 1].id;
    }
  }

  /**
   * Cola de revision del admin: conciliaciones hechas por cobradores y todo lo que se cerro sin
   * evidencia. Es la contraparte de dejar que el cobrador cierre sus propias consultas: nadie le
   * pide permiso a nadie, pero todo queda a la vista de quien controla.
   */
  async claimsToReview(query: { days?: number; onlyWeak?: boolean }) {
    const days = Math.min(Math.max(query.days ?? 7, 1), 60);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const qb = this.dataSource
      .getRepository(BankTransferClaim)
      .createQueryBuilder('c')
      .innerJoinAndSelect('c.bankTransfer', 't')
      .where('c.status = :status', { status: ClaimStatus.ACTIVA })
      .andWhere('c.claimedAt >= :since', { since })
      .andWhere('c."paymentId" IS NOT NULL')
      // Las que el admin ya marco como revisadas salen de la cola.
      .andWhere(
        `NOT EXISTS (SELECT 1 FROM "audit_logs" a WHERE a."action" = :reviewed AND a."bankTransferId" = c."bankTransferId" AND a."metadata" LIKE '%' || c."id"::text || '%')`,
        { reviewed: CLAIM_REVIEWED },
      )
      .orderBy('c.claimedAt', 'DESC')
      .take(100);
    const claims = await qb.getMany();
    const infos = await this.paymentInfos(this.dataSource.manager, claims.map((c) => c.paymentId));
    return claims
      .filter((c) => !query.onlyWeak || c.matchStrength === 'DEBIL')
      .map((c) => ({
        ...this.toClaimDto(c, c.paymentId ? infos.get(c.paymentId) : undefined),
        transferId: c.bankTransferId,
        transferAmount: Number(c.bankTransfer?.amount ?? 0),
        senderName: c.bankTransfer?.senderName ?? null,
        bankDocNumber: c.bankTransfer?.bankDocNumber ?? null,
        movementAt: c.bankTransfer?.movementAt ?? null,
      }));
  }

  /**
   * El admin reviso una conciliacion de la cola y esta bien: sale de la cola sin anular nada.
   * Queda en la auditoria quien la reviso y cuando. Repetirlo no duplica el registro.
   */
  async markReviewed(id: string, claimId: string, actor: Actor): Promise<{ claimId: string; reviewed: true }> {
    if (actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Solo administración puede marcar revisada una conciliación.');
    }
    const result = await this.dataSource.transaction(async (manager) => {
      // Serializa dos revisiones de la misma toma y su anulación: la auditoría no se duplica.
      const claim = await manager.getRepository(BankTransferClaim).findOne({
        where: { id: claimId, bankTransferId: id }, lock: { mode: 'pessimistic_write' },
      });
      if (!claim) throw new NotFoundException('Conciliación no encontrada.');
      if (claim.status !== ClaimStatus.ACTIVA) throw new ConflictException('Esta conciliación ya fue anulada: no hace falta revisarla.');
      const already = await manager
        .getRepository(AuditLog)
        .createQueryBuilder('a')
        .where('a.action = :action AND a."bankTransferId" = :id AND a.metadata LIKE :claim', { action: CLAIM_REVIEWED, id, claim: `%${claimId}%` })
        .getCount();
      if (already === 0) {
        await this.audit(manager, {
          ...this.actorAudit(actor), action: CLAIM_REVIEWED,
          bankTransferId: id, paymentId: claim.paymentId ?? null,
          metadata: JSON.stringify({ claimId, receiptNumber: claim.receiptNumber, reviewedByName: await this.resolveName(manager, actor) }),
        });
      }
      return { claimId, reviewed: true as const, paymentId: claim.paymentId };
    });
    if (result.paymentId) {
      try { this.gateway.emitPaymentsChanged({ type: 'PAYMENT_ADMIN_REVIEWED', paymentId: result.paymentId }); }
      catch { this.logger.warn('La revisión quedó registrada; no se pudo avisar a las otras pantallas.'); }
    }
    return { claimId: result.claimId, reviewed: result.reviewed };
  }

  // ----------------------------------------------------------- escritura

  private claimsSummary(claims: BankTransferClaim[], infos?: Map<string, PaymentInfo>) {
    return claims
      .map((claim) => {
        const who = claim.claimedByName || claim.claimedByUsername || claim.claimedById;
        const at = new Date(claim.claimedAt).toLocaleTimeString('es-PY', { timeZone: 'America/Asuncion', hour: '2-digit', minute: '2-digit' });
        const info = claim.paymentId ? infos?.get(claim.paymentId) : undefined;
        const ref =
          claim.referenceType === ClaimReferenceType.CONSULTA
            ? `consulta ${info?.paymentRef ?? claim.referenceValue}`
            : `${referenceLabel(claim.referenceType)} ${claim.referenceValue}`;
        return `${roleLabel(claim.claimedByRole)} ${who} a las ${at} (${ref}, ${formatMoney(Number(claim.amount))})`;
      })
      .join('; ');
  }

  private conflictMessage(claims: BankTransferClaim[], infos?: Map<string, PaymentInfo>) {
    return `Transferencia ya tomada por ${this.claimsSummary(claims, infos)}.`;
  }

  /**
   * Toma de una transferencia por el usuario logueado, por el total o por una parte.
   * La garantia contra el doble uso es el saldo: la base rechaza cualquier toma que haga que la
   * suma de las tomas activas supere el monto de la transferencia.
   */
  async claim(
    id: string,
    input: {
      referenceType: ClaimReferenceType.TICKET | ClaimReferenceType.CLIENTE;
      referenceValue: string;
      idempotencyKey: string;
      note?: string;
      amount?: number;
      /** El usuario ya vio el aviso de referencia repetida y aun asi quiere seguir. */
      confirmReuse?: boolean;
    },
    actor: Actor,
  ): Promise<{ transfer: BankTransferDto; receipt: BankReceiptDto }> {
    if (actor.role !== UserRole.CAJERO && actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Solo caja o administración pueden tomar una transferencia directamente.');
    }
    const referenceValue = normalizeReference(input.referenceValue);
    if (!referenceValue) throw new BadRequestException('Ingresá el número de ticket o cliente.');

    type Outcome =
      | { kind: 'ok'; transfer: BankTransfer; claim: BankTransferClaim }
      | { kind: 'idempotent'; transfer: BankTransfer; claim: BankTransferClaim }
      | { kind: 'conflict'; message: string; transferId: string; reason: string; confirmable?: boolean };

    let outcome: Outcome;
    try {
      outcome = await this.dataSource.transaction(async (manager): Promise<Outcome> => {
        const transferRepo = manager.getRepository(BankTransfer);
        const claimRepo = manager.getRepository(BankTransferClaim);

        const previous = await claimRepo.findOne({ where: { idempotencyKey: input.idempotencyKey } });
        if (previous) {
          if (previous.bankTransferId !== id || previous.claimedById !== actor.userId ||
              previous.claimedByRole !== actor.role || previous.status !== ClaimStatus.ACTIVA ||
              previous.referenceType !== input.referenceType || previous.referenceValue !== referenceValue ||
              (input.amount !== undefined && cents(previous.amount) !== cents(input.amount)) ||
              (previous.note ?? '') !== (input.note?.trim() ?? '')) {
            throw new ConflictException('Clave de operación repetida. Volvé a abrir la transferencia.');
          }
          const transfer = await transferRepo.findOneByOrFail({ id });
          if (currencyIso(transfer.currency) !== 'PYG') {
            return { kind: 'conflict', message: 'La moneda de esta transferencia no es PYG. Queda visible para revisión pero no se puede tomar.', transferId: id, reason: 'MONEDA_NO_SOPORTADA' };
          }
          return { kind: 'idempotent', transfer, claim: previous };
        }

        const transfer = await transferRepo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
        if (!transfer) throw new NotFoundException('Transferencia no encontrada.');

        if (transfer.status === BankTransferStatus.REVERSADA) {
          return { kind: 'conflict', message: 'El banco reversó esta transferencia: no se puede tomar.', transferId: id, reason: 'REVERSADA' };
        }
        if (transfer.status === BankTransferStatus.BLOQUEADA) {
          return { kind: 'conflict', message: 'Transferencia en revisión del administrador (posible duplicado).', transferId: id, reason: 'BLOQUEADA' };
        }
        if (currencyIso(transfer.currency) !== 'PYG') {
          return { kind: 'conflict', message: 'La moneda de esta transferencia no es PYG. Queda visible para revisión pero no se puede tomar.', transferId: id, reason: 'MONEDA_NO_SOPORTADA' };
        }

        const active = await claimRepo.find({ where: { bankTransferId: id, status: ClaimStatus.ACTIVA }, order: { claimedAt: 'DESC' } });
        const available = remainingCents(transfer);
        if (available <= 0) {
          const infos = await this.paymentInfos(manager, active.map((c) => c.paymentId));
          return { kind: 'conflict', message: this.conflictMessage(active, infos), transferId: id, reason: 'TOMADA' };
        }

        const amount = resolveAmountToClaim(input.amount, available, transfer.currency);
        if ('error' in amount) throw new BadRequestException(amount.error);

        // Con pagos partidos el mismo ticket puede recibir dos transferencias: se avisa, no se prohibe.
        const sameReference = await claimRepo.find({
          where: { referenceType: input.referenceType, referenceValue, status: ClaimStatus.ACTIVA },
          order: { claimedAt: 'DESC' },
          take: 5,
        });
        if (sameReference.length > 0 && !input.confirmReuse) {
          const taken = sameReference
            .map((c) => `${formatMoney(Number(c.amount))} por ${c.claimedByName || c.claimedByUsername} (${c.receiptNumber})`)
            .join(', ');
          return {
            kind: 'conflict',
            confirmable: true,
            message: `El ${referenceLabel(input.referenceType)} ${referenceValue} ya tiene cobrado: ${taken}. Confirmá solo si este pago es otra parte del mismo cobro.`,
            transferId: id,
            reason: 'REFERENCIA_USADA',
          };
        }

        const claim = claimRepo.create({
          bankTransferId: transfer.id,
          receiptNumber: await this.nextReceiptNumber(manager),
          amount: fromCents(amount.cents),
          referenceType: input.referenceType,
          referenceValue,
          note: input.note?.trim() || null,
          paymentId: null,
          claimedById: actor.userId,
          claimedByUsername: actor.username ?? null,
          claimedByName: await this.resolveName(manager, actor),
          claimedByRole: actor.role,
          claimedAt: new Date(),
          status: ClaimStatus.ACTIVA,
          printCount: 0,
          idempotencyKey: input.idempotencyKey,
        });
        await claimRepo.save(claim);

        transfer.allocatedAmount = fromCents(cents(transfer.allocatedAmount) + amount.cents);
        transfer.status = statusFromAllocation(transfer);
        await transferRepo.save(transfer);

        await this.audit(manager, {
          ...this.actorAudit(actor),
          action: 'BANK_TRANSFER_CLAIMED',
          bankTransferId: transfer.id,
          metadata: JSON.stringify({
            receiptNumber: claim.receiptNumber,
            referenceType: claim.referenceType,
            referenceValue: claim.referenceValue,
            amount: Number(claim.amount),
            transferAmount: Number(transfer.amount),
            partial: cents(claim.amount) < cents(transfer.amount),
            reusedReference: sameReference.length > 0 || undefined,
          }),
        });
        return { kind: 'ok', transfer, claim };
      });
    } catch (error) {
      if (this.isCheckViolation(error)) {
        outcome = {
          kind: 'conflict',
          message: 'El saldo de esta transferencia cambió mientras la tomabas: ya no alcanza. Revisá el panel.',
          transferId: id,
          reason: 'SALDO_INSUFICIENTE',
        };
      } else if (this.isUniqueViolation(error)) {
        outcome = {
          kind: 'conflict',
          message: 'Otro usuario acaba de tomar esta transferencia. Revisá el panel.',
          transferId: id,
          reason: 'CARRERA',
        };
      } else {
        throw error;
      }
    }

    if (outcome.kind === 'conflict') {
      // El intento fallido tambien queda auditado: es la senal mas util ante un intento de doble uso.
      await this.audit(this.dataSource.manager, {
        ...this.actorAudit(actor),
        action: 'BANK_TRANSFER_CLAIM_CONFLICT',
        bankTransferId: outcome.transferId,
        metadata: JSON.stringify({ reason: outcome.reason, referenceType: input.referenceType, referenceValue }),
      });
      throw new ConflictException({
        statusCode: 409,
        message: outcome.message,
        error: 'Conflict',
        reason: outcome.reason,
        confirmable: outcome.confirmable ?? false,
      });
    }

    if (outcome.kind === 'ok') await this.broadcast(outcome.transfer, 'bank-transfers:updated');
    const claims = (await this.activeClaimsFor(this.dataSource.manager, [outcome.transfer.id])).get(outcome.transfer.id) ?? [];
    return {
      transfer: this.toDto(outcome.transfer, claims, seesFullSenderData(actor.role)),
      receipt: this.toReceipt(outcome.transfer, outcome.claim),
    };
  }

  /** Elige la toma sobre la que se va a operar cuando la transferencia tiene varias activas. */
  private pickClaim(claims: BankTransferClaim[], claimId?: string) {
    if (claims.length === 0) throw new ConflictException('La transferencia no tiene una toma activa.');
    if (claimId) {
      const found = claims.find((c) => c.id === claimId);
      if (!found) throw new ConflictException('Esa toma ya no está activa.');
      return found;
    }
    if (claims.length > 1) {
      throw new BadRequestException('La transferencia tiene varias tomas activas: elegí cuál.');
    }
    return claims[0];
  }

  /**
   * Anulacion de una toma: solo ADMIN, con motivo. No borra nada: la toma queda ANULADA con
   * quien, cuando y por que, y su monto vuelve a estar disponible en la transferencia.
   */
  async void(id: string, reason: string, actor: Actor, claimId: string): Promise<BankTransferDto> {
    if (actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Solo administración puede anular una toma bancaria.');
    }
    const trimmed = (reason || '').trim();
    if (trimmed.length < 10) throw new BadRequestException('El motivo de anulación debe tener al menos 10 caracteres.');
    if (!claimId) throw new BadRequestException('Indicá la toma exacta que se anula.');

    const result = await this.dataSource.transaction(async (manager) => {
      const transferRepo = manager.getRepository(BankTransfer);
      const claimRepo = manager.getRepository(BankTransferClaim);
      const transfer = await transferRepo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!transfer) throw new NotFoundException('Transferencia no encontrada.');
      const active = await claimRepo.find({
        where: { bankTransferId: id, status: ClaimStatus.ACTIVA },
        order: { claimedAt: 'DESC' },
        lock: { mode: 'pessimistic_write' },
      });
      const claim = this.pickClaim(active, claimId);
      const claimedCents = cents(claim.amount);
      const activeAmounts = active.map((row) => cents(row.amount));
      const activeTotal = activeAmounts.reduce((total, amount) => total + amount, 0);
      if (!Number.isSafeInteger(claimedCents) || claimedCents <= 0 ||
          activeAmounts.some((amount) => !Number.isSafeInteger(amount) || amount <= 0) ||
          !Number.isSafeInteger(activeTotal) || activeTotal !== cents(transfer.allocatedAmount)) {
        throw new ConflictException('El saldo tomado de la transferencia no coincide con su historial. No se anuló nada; requiere revisión.');
      }

      let revertedPayment: Payment | null = null;
      let decisionUndone = false;
      if (claim.paymentId) {
        const paymentRepo = manager.getRepository(Payment);
        const payment = await paymentRepo.findOne({ where: { id: claim.paymentId }, lock: { mode: 'pessimistic_write' } });
        if (!payment) {
          throw new ConflictException('La consulta de esta toma no existe. No se anuló nada; requiere revisión.');
        }
        if (payment.printedAt || payment.cashPaidAt) {
          throw new ConflictException('La consulta conciliada ya tiene ticket impreso o pago en caja: no se puede anular.');
        }
        // El pago ya está bloqueado. Leer las tomas de otros movimientos SIN bloquearlas
        // evita invertir el orden de locks (movimiento → consulta) y causar un deadlock.
        const paymentClaims = await claimRepo.find({
          where: { paymentId: payment.id, status: ClaimStatus.ACTIVA },
        });
        const paymentClaimAmounts = paymentClaims.map((row) => cents(row.amount));
        const paymentClaimTotal = paymentClaimAmounts.reduce((total, amount) => total + amount, 0);
        if (!paymentClaims.some((row) => row.id === claim.id) ||
            paymentClaimAmounts.some((amount) => !Number.isSafeInteger(amount) || amount <= 0) ||
            !Number.isSafeInteger(paymentClaimTotal) || paymentClaimTotal !== cents(payment.allocatedAmount)) {
          throw new ConflictException('El saldo conciliado de la consulta no coincide con su historial. No se anuló nada; requiere revisión.');
        }
        const before = payment.status;
        payment.allocatedAmount = fromCents(cents(payment.allocatedAmount) - claimedCents);
        // Si deja de estar cubierta del todo, vuelve a la cola de decision.
        if (remainingCents(payment) > 0 && !DECIDABLE_PAYMENT_STATES.includes(payment.status)) {
          payment.status = PaymentState.PENDIENTE_VERIFICACION;
          payment.verifiedById = null;
          payment.verifiedByUsername = null;
          payment.verifiedByName = null;
          payment.verifiedAt = null;
          payment.decisionReason = null;
        }
        decisionUndone = before !== payment.status;
        await paymentRepo.save(payment);
        await this.audit(manager, {
          ...this.actorAudit(actor),
          action: 'PAYMENT_BANK_RECONCILIATION_VOIDED',
          paymentId: payment.id,
          bankTransferId: transfer.id,
          beforeState: before,
          afterState: payment.status,
          metadata: JSON.stringify({ reason: trimmed, receiptNumber: claim.receiptNumber, amount: Number(claim.amount) }),
        });
        revertedPayment = payment;
      }

      claim.status = ClaimStatus.ANULADA;
      claim.voidedById = actor.userId;
      claim.voidedByUsername = actor.username ?? null;
      claim.voidedByName = await this.resolveName(manager, actor);
      claim.voidedAt = new Date();
      claim.voidReason = trimmed;
      await claimRepo.save(claim);

      transfer.allocatedAmount = fromCents(cents(transfer.allocatedAmount) - claimedCents);
      transfer.status = statusFromAllocation(transfer);
      await transferRepo.save(transfer);

      await this.audit(manager, {
        ...this.actorAudit(actor),
        action: 'BANK_TRANSFER_CLAIM_VOIDED',
        bankTransferId: transfer.id,
        metadata: JSON.stringify({
          reason: trimmed,
          receiptNumber: claim.receiptNumber,
          amount: Number(claim.amount),
          claimedBy: claim.claimedByUsername,
          referenceType: claim.referenceType,
          referenceValue: claim.referenceValue,
        }),
      });
      const remainingClaims = active.filter((row) => row.status === ClaimStatus.ACTIVA);
      const infos = await this.paymentInfos(manager, remainingClaims.map((row) => row.paymentId));
      return {
        transfer,
        revertedPayment,
        decisionUndone,
        transferDto: this.toDto(transfer, remainingClaims, seesFullSenderData(actor.role), infos),
      };
    });

    // El commit ya ocurrió. Una falla de websocket no debe convertir una anulación efectiva en 500.
    try {
      await this.broadcast(result.transfer, 'bank-transfers:updated');
    } catch {
      this.logger.warn('No se pudo emitir la actualización de una toma anulada; el estado persistido sigue vigente.');
    }
    if (result.revertedPayment) {
      try {
        this.gateway.emitPaymentsChanged({
          type: result.decisionUndone ? 'PAYMENT_DECISION_UNDONE' : 'PAYMENT_UPDATED',
          paymentId: result.revertedPayment.id,
          targetUserId: result.revertedPayment.createdById,
        });
      } catch {
        this.logger.warn('No se pudo emitir la actualización de una consulta cuya toma fue anulada.');
      }
    }
    // Una toma nueva puede entrar inmediatamente después del commit; preferir el estado fresco.
    // Si esa lectura falla, la operación ya quedó confirmada y se devuelve su snapshot transaccional.
    try {
      return await this.getOne(id, actor);
    } catch {
      this.logger.warn('No se pudo refrescar la transferencia anulada; se devuelve el estado confirmado al commit.');
      return result.transferDto;
    }
  }

  /** Libera una transferencia bloqueada por posible duplicado, tras revision del admin. */
  async release(id: string, reason: string, actor: Actor): Promise<BankTransferDto> {
    const trimmed = (reason || '').trim();
    if (trimmed.length < 10) throw new BadRequestException('Explicá en al menos 10 caracteres por qué se libera.');
    const transfer = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(BankTransfer);
      const row = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!row) throw new NotFoundException('Transferencia no encontrada.');
      if (row.status !== BankTransferStatus.BLOQUEADA) throw new ConflictException('La transferencia no está bloqueada.');
      const blockedReason = row.blockedReason;
      row.status = BankTransferStatus.DISPONIBLE;
      row.status = statusFromAllocation(row);
      await repo.save(row);
      await this.audit(manager, {
        ...this.actorAudit(actor),
        action: 'BANK_TRANSFER_RELEASED',
        bankTransferId: row.id,
        metadata: JSON.stringify({ reason: trimmed, blockedReason }),
      });
      return row;
    });
    await this.broadcast(transfer, 'bank-transfers:updated');
    return this.getOne(id, actor);
  }

  /**
   * Prepara el comprobante para el dialogo de impresion, sin contarlo como impreso: el navegador no
   * sabe si la persona imprimio o cancelo, eso se confirma despues con `print`. Queda auditado que se
   * abrio el dialogo, para ver aperturas que nadie confirmo. El papel lleva el numero de copia que
   * tendra si se confirma.
   */
  private bankPrintTarget(transfer: BankTransfer, claim: BankTransferClaim, payment: Payment | null): PrintTarget {
    const isTicket = payment && [PaymentState.CONFIRMADO, PaymentState.CONFIRMADO_MANUAL].includes(payment.status);
    return {
      scopeKey: isTicket ? `PAYMENT:${payment.id}` : `CLAIM:${claim.id}`,
      paymentId: claim.paymentId, bankTransferId: transfer.id, claimId: claim.id, receiptNumber: claim.receiptNumber,
      openAction: 'BANK_TRANSFER_RECEIPT_PRINT_OPENED', printAction: 'BANK_TRANSFER_RECEIPT_PRINTED',
    };
  }

  async printPreview(id: string, actor: Actor, claimId?: string, reason?: string): Promise<BankReceiptDto> {
    const result = await this.dataSource.transaction(async (manager) => {
    const transfer = await manager.getRepository(BankTransfer).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!transfer) throw new NotFoundException('Transferencia no encontrada.');
    const active = await manager.getRepository(BankTransferClaim).find({
      where: { bankTransferId: id, status: ClaimStatus.ACTIVA },
      order: { claimedAt: 'DESC' },
      lock: { mode: 'pessimistic_write' },
    });
    const claim = this.pickClaim(active, claimId);
    if (![UserRole.ADMIN, UserRole.CAJERO, UserRole.COBRADOR].includes(actor.role as UserRole)) throw new ForbiddenException('No tenés permiso para imprimir comprobantes bancarios.');
    if (actor.role !== UserRole.ADMIN && claim.claimedById !== actor.userId) {
      throw new ForbiddenException('Solo quien tomó la transferencia o un administrador puede imprimir el comprobante.');
    }
    const payment = claim.paymentId ? await manager.getRepository(Payment).findOne({ where: { id: claim.paymentId }, lock: { mode: 'pessimistic_write' } }) : null;
    const grant = await authorizePrint(manager, this.bankPrintTarget(transfer, claim, payment), actor, Math.max(claim.printCount, payment?.printedAt ? 1 : 0), reason);
    const infos = await this.paymentInfos(manager, [claim.paymentId]);
    const receipt = this.toReceipt(transfer, claim, claim.paymentId ? infos.get(claim.paymentId) : undefined);
    return { transfer, receipt: { ...receipt, printCount: claim.printCount + 1, printAuthorizationId: grant.authorizationId, printScope: grant.scopeKey.startsWith('PAYMENT:') ? 'PAYMENT' as const : 'CLAIM' as const, printCopyNumber: grant.copyNumber, reprintReason: grant.reprintReason } };
    });
    try { await this.broadcast(result.transfer, 'bank-transfers:updated'); } catch { this.logger.warn('La apertura quedó autorizada; no se pudo avisar a las otras pantallas.'); }
    return result.receipt;
  }

  /**
   * Registra que el comprobante salio impreso (la persona lo confirmo despues del dialogo) y
   * devuelve sus datos. Una consulta conciliada se entrega con este comprobante: cuenta tambien
   * como su ticket impreso, asi no queda pidiendo otra impresion para pasar a caja.
   */
  async print(id: string, actor: Actor, claimId?: string, authorizationId?: string): Promise<BankReceiptDto> {
    const { receipt, transfer, printedPayment } = await this.dataSource.transaction(async (manager) => {
      const transfer = await manager.getRepository(BankTransfer).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!transfer) throw new NotFoundException('Transferencia no encontrada.');
      const claimRepo = manager.getRepository(BankTransferClaim);
      const active = await claimRepo.find({
        where: { bankTransferId: id, status: ClaimStatus.ACTIVA },
        order: { claimedAt: 'DESC' },
        lock: { mode: 'pessimistic_write' },
      });
      const claim = this.pickClaim(active, claimId);
      if (![UserRole.ADMIN, UserRole.CAJERO, UserRole.COBRADOR].includes(actor.role as UserRole)) throw new ForbiddenException('No tenés permiso para imprimir comprobantes bancarios.');
      if (actor.role !== UserRole.ADMIN && claim.claimedById !== actor.userId) {
        throw new ForbiddenException('Solo quien tomó la transferencia o un administrador puede imprimir el comprobante.');
      }
      const paymentRepo = manager.getRepository(Payment);
      const payment = claim.paymentId ? await paymentRepo.findOne({ where: { id: claim.paymentId }, lock: { mode: 'pessimistic_write' } }) : null;
      const target = this.bankPrintTarget(transfer, claim, payment);
      const grant = await checkPrintAuthorization(manager, target, actor, authorizationId, [`CLAIM:${claim.id}`, ...(claim.paymentId ? [`PAYMENT:${claim.paymentId}`] : [])]);
      if (grant.confirmed) {
        const infos = await this.paymentInfos(manager, [claim.paymentId]);
        return { receipt: this.toReceipt(transfer, claim, claim.paymentId ? infos.get(claim.paymentId) : undefined), transfer, printedPayment: null };
      }
      claim.printCount += 1;
      claim.lastPrintedAt = new Date();
      await claimRepo.save(claim);
      await this.audit(manager, {
        ...this.actorAudit(actor),
        action: 'BANK_TRANSFER_RECEIPT_PRINTED',
        bankTransferId: transfer.id,
        paymentId: claim.paymentId,
        metadata: JSON.stringify({ receiptNumber: claim.receiptNumber, printCount: claim.printCount, authorizationId: grant.authorizationId, copyNumber: grant.copyNumber, reason: grant.reprintReason }),
      });
      let printedPayment: Payment | null = null;
      if (claim.paymentId) {
        if (payment && grant.scopeKey === `PAYMENT:${payment.id}` && !payment.printedAt && [PaymentState.CONFIRMADO, PaymentState.CONFIRMADO_MANUAL].includes(payment.status)) {
          payment.printedAt = new Date();
          printedPayment = await paymentRepo.save(payment);
          await this.audit(manager, {
            ...this.actorAudit(actor),
            action: 'PAYMENT_PRINTED',
            paymentId: payment.id,
            bankTransferId: transfer.id,
            beforeState: payment.status,
            afterState: payment.status,
            metadata: JSON.stringify({ receiptNumber: claim.receiptNumber }),
          });
        }
      }
      const infos = await this.paymentInfos(manager, [claim.paymentId]);
      return {
        receipt: this.toReceipt(transfer, claim, claim.paymentId ? infos.get(claim.paymentId) : undefined),
        transfer,
        printedPayment,
      };
    });
    // Las demas pantallas pasan de "Imprimir" a "Reimprimir" sin recargar.
    try {
      await this.broadcast(transfer, 'bank-transfers:updated');
    } catch {
      this.logger.warn('No se pudo avisar de la impresión; su confirmación ya quedó guardada.');
    }
    if (printedPayment) {
      try {
        this.gateway.emitPaymentsChanged({ type: 'PAYMENT_PRINTED', paymentId: printedPayment.id, targetUserId: printedPayment.createdById });
      } catch {
        this.logger.warn('No se pudo avisar del ticket impreso; su confirmación ya quedó guardada.');
      }
    }
    return receipt;
  }

  /**
   * Concilia una transferencia con una consulta: crea la toma por el monto que corresponde y,
   * cuando la consulta queda cubierta del todo, la aprueba. El ADMIN concilia cualquier consulta;
   * el COBRADOR solo las suyas, y la evidencia del calce queda guardada en la toma.
   */
  async reconcile(
    id: string,
    paymentId: string,
    idempotencyKey: string,
    actor: Actor,
    options?: { amount?: number },
  ): Promise<BankTransferDto> {
    let result: { transfer: BankTransfer; claim: BankTransferClaim; payment: Payment; approved: boolean };
    try {
      result = await this.dataSource.transaction(async (manager) => {
        const transferRepo = manager.getRepository(BankTransfer);
        const claimRepo = manager.getRepository(BankTransferClaim);
        const paymentRepo = manager.getRepository(Payment);

        const previous = await claimRepo.findOne({ where: { idempotencyKey } });
        if (previous) {
          if (previous.bankTransferId !== id || previous.paymentId !== paymentId ||
              previous.claimedById !== actor.userId || previous.claimedByRole !== actor.role ||
              previous.referenceType !== ClaimReferenceType.CONSULTA || previous.status !== ClaimStatus.ACTIVA ||
              (options?.amount !== undefined && cents(previous.amount) !== cents(options.amount))) {
            throw new ConflictException('Clave de operación repetida para otra conciliación. Volvé a abrir la consulta.');
          }
          const transfer = await transferRepo.findOneByOrFail({ id });
          const payment = await paymentRepo.findOneByOrFail({ id: paymentId });
          return { transfer, claim: previous, payment, approved: false };
        }

        const transfer = await transferRepo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
        if (!transfer) throw new NotFoundException('Transferencia no encontrada.');
        if (transfer.status === BankTransferStatus.REVERSADA || transfer.status === BankTransferStatus.BLOQUEADA) {
          throw new ConflictException(`La transferencia está ${transfer.status.toLowerCase()}: no se puede conciliar.`);
        }
        const available = remainingCents(transfer);
        if (available <= 0) {
          const active = await claimRepo.find({ where: { bankTransferId: id, status: ClaimStatus.ACTIVA } });
          const infos = await this.paymentInfos(manager, active.map((c) => c.paymentId));
          throw new ConflictException(this.conflictMessage(active, infos));
        }

        const payment = await paymentRepo.findOne({ where: { id: paymentId }, lock: { mode: 'pessimistic_write' } });
        if (!payment) throw new NotFoundException('Consulta no encontrada.');
        if (actor.role === UserRole.COBRADOR && payment.createdById !== actor.userId) {
          throw new ForbiddenException('Solo podés conciliar tus propias consultas.');
        }
        if (payment.isAtlasAccount !== true) {
          throw new ConflictException('Esta consulta no está marcada como depositada en Atlas. Si el comprobante es de Atlas, corregí el banco de depósito antes de conciliarla.');
        }
        // No hay tipo de cambio ni liquidación multimoneda: comparar montos sin ISO permitiría
        // aprobar 1.000 PYG con 1.000 USD. También fallamos cerrados ante códigos históricos inválidos.
        const transferCurrency = currencyIso(transfer.currency);
        const paymentCurrency = currencyIso(payment.currency);
        if (paymentCurrency !== 'PYG' || transferCurrency !== paymentCurrency) {
          throw new ConflictException('La moneda del movimiento no coincide con la consulta en PYG. No se aplicó ningún monto.');
        }
        if (!DECIDABLE_PAYMENT_STATES.includes(payment.status)) {
          throw new ConflictException('La consulta ya fue resuelta. Anulá la decisión antes de conciliarla.');
        }
        const reviewedByOther =
          !!payment.reviewClaimedById &&
          !!payment.reviewClaimExpiresAt &&
          new Date(payment.reviewClaimExpiresAt).getTime() > Date.now() &&
          payment.reviewClaimedById !== actor.userId;
        if (reviewedByOther) {
          throw new ConflictException(`La consulta está tomada en revisión por ${payment.reviewClaimedByName || payment.reviewClaimedByUsername}.`);
        }

        const pending = remainingCents(payment);
        if (pending <= 0) throw new ConflictException('La consulta ya está cubierta por otras transferencias.');
        const amount = resolveAmountToClaim(options?.amount ?? fromCents(Math.min(available, pending)), Math.min(available, pending), transfer.currency);
        if ('error' in amount) throw new BadRequestException(amount.error);

        const known = transfer.senderAccount
          ? (await this.knownClientsByAccount(manager, [transfer.senderAccount])).get(senderAccountKey(transfer))
          : undefined;
        const match = assessMatch(transfer, payment, known);

        const actorName = await this.resolveName(manager, actor);
        const claim = claimRepo.create({
          bankTransferId: transfer.id,
          receiptNumber: await this.nextReceiptNumber(manager),
          amount: fromCents(amount.cents),
          referenceType: ClaimReferenceType.CONSULTA,
          referenceValue: payment.paymentRef || payment.id,
          paymentId: payment.id,
          matchStrength: match.strength,
          matchEvidence: match.evidence.join(','),
          note: null,
          claimedById: actor.userId,
          claimedByUsername: actor.username ?? null,
          claimedByName: actorName,
          claimedByRole: actor.role,
          claimedAt: new Date(),
          status: ClaimStatus.ACTIVA,
          printCount: 0,
          idempotencyKey,
        });
        await claimRepo.save(claim);

        transfer.allocatedAmount = fromCents(cents(transfer.allocatedAmount) + amount.cents);
        transfer.status = statusFromAllocation(transfer);
        await transferRepo.save(transfer);

        const before = payment.status;
        payment.allocatedAmount = fromCents(cents(payment.allocatedAmount) + amount.cents);
        const approved = remainingCents(payment) <= 0;
        if (approved) {
          payment.status = PaymentState.CONFIRMADO;
          payment.verifiedById = actor.userId;
          payment.verifiedByUsername = actor.username ?? null;
          payment.verifiedByName = actorName;
          payment.verifiedAt = new Date();
          payment.decisionReason = `Conciliado con transferencia bancaria ${claim.receiptNumber}`;
          payment.rejectionReason = null as any;
          payment.reviewClaimedById = null;
          payment.reviewClaimedByUsername = null;
          payment.reviewClaimedByName = null;
          payment.reviewClaimedAt = null;
          payment.reviewClaimExpiresAt = null;
        }
        await paymentRepo.save(payment);

        await this.audit(manager, {
          ...this.actorAudit(actor),
          action: 'PAYMENT_BANK_RECONCILED',
          paymentId: payment.id,
          bankTransferId: transfer.id,
          beforeState: before,
          afterState: payment.status,
          metadata: JSON.stringify({
            receiptNumber: claim.receiptNumber,
            amount: Number(claim.amount),
            pendingAfter: fromCents(Math.max(0, remainingCents(payment))),
            bankDocNumber: transfer.bankDocNumber,
            matchStrength: match.strength,
            matchEvidence: match.evidence,
            byRole: actor.role,
          }),
        });
        return { transfer, claim, payment, approved };
      });
    } catch (error) {
      if (this.isCheckViolation(error)) {
        throw new ConflictException('El saldo de la transferencia o de la consulta cambió mientras conciliabas. Revisá el panel.');
      }
      if (!this.isUniqueViolation(error)) throw error;
      throw new ConflictException('La transferencia o la consulta acaban de ser usadas por otro usuario. Revisá el panel.');
    }

    await this.broadcast(result.transfer, 'bank-transfers:updated');
    this.gateway.emitPaymentsChanged({
      type: result.approved ? 'PAYMENT_MATCH_CONFIRMED' : 'PAYMENT_UPDATED',
      paymentId: result.payment.id,
      targetUserId: result.payment.createdById,
    });
    return this.getOne(id, actor);
  }
}
