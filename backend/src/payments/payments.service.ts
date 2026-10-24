import { Injectable, ConflictException, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository, Not, LessThan, Brackets, QueryFailedError } from 'typeorm';
import { Payment, PaymentState } from './entities/payment.entity';
import { Movement } from '../movements/entities/movement.entity';
import { AuditLog } from './entities/audit-log.entity';
import { AuditQueryDto } from './dto/audit-query.dto';
import { ListPaymentsQueryDto } from './dto/list-payments-query.dto';
import { User, UserRole } from '../users/entities/user.entity';
import { hammingDistanceHex64 } from './proof-dhash';
import { BankTransferClaim, ClaimStatus } from '../bank/entities/bank-transfer-claim.entity';
import { BankTransfer } from '../bank/entities/bank-transfer.entity';
import { enforcePaymentsListScope, normalizePaymentsPage } from './payments-list-policy';
import { authorizePrint, checkPrintAuthorization, PrintTarget } from './print-authorization';
import { attachPaymentControls, hasPendingAdminReviewSql } from './payment-controls';

type Actor = { userId: string; username?: string; name?: string; role?: UserRole | string };

// Los registros del sistema usan userId "system"/"system-auto": solo se buscan identificadores reales.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Solo un pago pendiente o en revision admite una decision (aprobar o rechazar).
const DECIDABLE_STATES = [PaymentState.PENDIENTE_VERIFICACION, PaymentState.EN_REVISION];

export type PaymentsListItem = Omit<Payment, 'proofUrl' | 'fileHash' | 'proofDhash' | 'observation'> & {
  hasProof: boolean;
};

type PaymentsListResult = {
  items: PaymentsListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

@Injectable()
export class PaymentsService {
  constructor(
    @InjectRepository(Payment) private paymentRepo: Repository<Payment>,
    @InjectRepository(AuditLog) private auditRepo: Repository<AuditLog>,
  ) { }

  /**
   * Agrega a cada registro de auditoria lo necesario para leerlo sin codigos: el nombre de quien
   * actuo, la consulta (cliente, referencia, monto, banco de deposito, cobrador), la transferencia
   * del banco (monto, documento, hora) y el usuario afectado. Una consulta por tipo, no por fila.
   * Sin remitentes ni cuentas: el supervisor tambien lee la auditoria y ve esos datos enmascarados.
   */
  private async withAuditContext<T extends AuditLog>(logs: T[], options: { payments?: boolean } = {}) {
    const ids = (values: (string | null | undefined)[]) =>
      Array.from(new Set(values.filter((v): v is string => !!v && UUID_PATTERN.test(v))));
    const paymentIds = options.payments === false ? [] : ids(logs.map((l) => l.paymentId));
    const transferIds = options.payments === false ? [] : ids(logs.map((l) => l.bankTransferId));
    const userIds = ids(logs.flatMap((l) => [l.userId, l.targetUserId]));
    if (paymentIds.length + transferIds.length + userIds.length === 0) return logs;

    const manager = this.paymentRepo.manager;
    const [payments, transfers, users]: [Payment[], BankTransfer[], User[]] = await Promise.all([
      paymentIds.length
        ? this.paymentRepo.find({
            where: { id: In(paymentIds) },
            relations: ['createdBy'],
            select: {
              id: true, amount: true, currency: true, clientName: true, clientCode: true, paymentRef: true,
              sourceBank: true, isAtlasAccount: true, status: true, createdBy: { id: true, name: true, username: true },
            },
          })
        : [],
      transferIds.length
        ? manager.getRepository(BankTransfer).find({
            where: { id: In(transferIds) },
            select: { id: true, amount: true, currency: true, bankDocNumber: true, movementAt: true },
          })
        : [],
      userIds.length
        ? manager.getRepository(User).find({ where: { id: In(userIds) }, select: { id: true, name: true, username: true } })
        : [],
    ]);
    const paymentById = new Map(payments.map((p) => [p.id, {
      id: p.id,
      amount: Number(p.amount),
      currency: p.currency ?? null,
      clientName: p.clientName ?? null,
      clientCode: p.clientCode ?? null,
      paymentRef: p.paymentRef ?? null,
      sourceBank: p.sourceBank ?? null,
      isAtlasAccount: p.isAtlasAccount ?? null,
      collectorName: p.createdBy?.name || p.createdBy?.username || null,
    }]));
    const transferById = new Map(transfers.map((t) => [t.id, {
      id: t.id,
      amount: Number(t.amount),
      currency: t.currency ?? null,
      bankDocNumber: t.bankDocNumber ?? null,
      movementAt: t.movementAt,
    }]));
    const userName = (id?: string | null) => {
      const user = id ? users.find((u) => u.id === id) : undefined;
      return user ? user.name || user.username : null;
    };
    return logs.map((l) => ({
      ...l,
      actorName: userName(l.userId),
      targetUserName: userName(l.targetUserId),
      ...(paymentIds.length ? { payment: l.paymentId ? paymentById.get(l.paymentId) ?? null : null } : {}),
      ...(transferIds.length ? { bankTransfer: l.bankTransferId ? transferById.get(l.bankTransferId) ?? null : null } : {}),
    }));
  }

  private async attachPaymentInfo(logs: AuditLog[], actor?: Actor) {
    const ids = Array.from(new Set(logs.map((l) => l.paymentId).filter(Boolean))) as string[];
    if (ids.length === 0) return logs as any;

    const payments = await this.paymentRepo.find({
      where: { id: In(ids) } as any,
      select: ['id', 'amount', 'clientName', 'clientCode', 'paymentRef', 'sourceBank', 'createdById'],
    });

    const owners = new Map(payments.map((p) => [p.id, p.createdById]));
    const byId = new Map(
      payments.map((p) => [
        p.id,
        {
          id: p.id,
          amount: typeof (p as any).amount === 'string' ? Number((p as any).amount) : (p as any).amount,
          clientName: p.clientName ?? null,
          clientCode: p.clientCode ?? null,
          paymentRef: p.paymentRef ?? null,
          sourceBank: p.sourceBank ?? null,
        },
      ]),
    );

    return logs.map((l) => ({
      ...(l as any),
      metadata: actor?.role === UserRole.COBRADOR && (!l.paymentId || owners.get(l.paymentId) !== actor.userId)
        ? null : l.metadata,
      payment: l.paymentId ? byId.get(l.paymentId) ?? null : null,
    }));
  }

  private async logAudit(params: {
    action: string;
    userId: string | undefined;
    actorUsername?: string;
    before?: PaymentState | null;
    after?: PaymentState | null;
    metadata?: string;
    paymentId?: string;
    movementId?: string;
    targetUserId?: string;
  }, manager?: EntityManager) {
    const auditRepo = manager ? manager.getRepository(AuditLog) : this.auditRepo;
    const log = auditRepo.create({
      action: params.action,
      userId: params.userId || 'system',
      actorUsername: params.actorUsername ?? null,
      beforeState: params.before ?? null,
      afterState: params.after ?? null,
      metadata: params.metadata ?? null,
      paymentId: params.paymentId ?? null,
      movementId: params.movementId ?? null,
      targetUserId: params.targetUserId ?? null,
    });
    await auditRepo.save(log);
  }

  private clearReviewClaim(payment: Payment) {
    payment.reviewClaimedById = null;
    payment.reviewClaimedByUsername = null;
    payment.reviewClaimedByName = null;
    payment.reviewClaimedAt = null;
    payment.reviewClaimExpiresAt = null;
  }

  private parseDateOnly(value: string, opts?: { endOfDay?: boolean }) {
    const trimmed = (value || '').trim();
    if (!trimmed) throw new BadRequestException('Fecha inválida.');

    const endOfDay = !!opts?.endOfDay;

    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const [y, m, d] = trimmed.split('-').map((x) => Number(x));
      const dt = new Date(y, (m || 1) - 1, d || 1);
      if (Number.isNaN(dt.getTime())) throw new BadRequestException('Fecha inválida.');
      dt.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
      return dt;
    }

    const dt = new Date(trimmed);
    if (Number.isNaN(dt.getTime())) throw new BadRequestException('Fecha inválida.');
    dt.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
    return dt;
  }

  private normalizeStatuses(query?: Pick<ListPaymentsQueryDto, 'status' | 'statuses'>): PaymentState[] {
    const statuses = new Set<PaymentState>();
    if (query?.status) statuses.add(query.status);
    for (const st of query?.statuses ?? []) statuses.add(st);
    return Array.from(statuses);
  }

  private buildPaymentsListQuery(query?: ListPaymentsQueryDto) {
    const lite = !!query?.lite;
    const qb = this.paymentRepo.createQueryBuilder('payment')
      .leftJoinAndSelect('payment.createdBy', 'createdBy');

    if (lite) {
      qb.select([
        'payment.id',
        'payment.amount',
        'payment.allocatedAmount',
        'payment.currency',
        'payment.clientName',
        'payment.clientCode',
        'payment.paymentRef',
        'payment.sourceBank',
        'payment.isAtlasAccount',
        'payment.status',
        'payment.createdAt',
        'payment.proofUrl',
        'payment.createdById',
        'payment.rejectionReason',
        'payment.decisionReason',
        'payment.printedAt',
        'payment.cashPaidAt',
        'payment.cashPaidById',
        'payment.cashPaidByUsername',
        'payment.cashPaidByName',
        'payment.reviewClaimedById',
        'payment.reviewClaimedByUsername',
        'payment.reviewClaimedByName',
        'payment.reviewClaimedAt',
        'payment.reviewClaimExpiresAt',
        'payment.verifiedById',
        'payment.verifiedByUsername',
        'payment.verifiedByName',
        'payment.verifiedAt',
        'createdBy.id',
        'createdBy.name',
        'createdBy.username',
      ]);
    } else {
      qb.leftJoinAndSelect('payment.matchedMovement', 'matchedMovement');
    }

    const statuses = this.normalizeStatuses(query);
    if (statuses.length > 0) {
      qb.andWhere('payment.status IN (:...statuses)', { statuses });
    }

    if (query?.sourceBank) {
      qb.andWhere('payment.sourceBank ILIKE :sourceBank', { sourceBank: `%${query.sourceBank.trim()}%` });
    }

    if (query?.isAtlasAccount !== undefined) {
      qb.andWhere('payment.isAtlasAccount = :isAtlasAccount', { isAtlasAccount: query.isAtlasAccount });
    }
    if (query?.workOpen) qb.andWhere(`(payment.status <> :rejected AND (payment."cashPaidAt" IS NULL OR ${hasPendingAdminReviewSql('payment')}))`, { rejected: PaymentState.RECHAZADO });
    if (query?.pendingAdminReview) qb.andWhere(`(${hasPendingAdminReviewSql('payment')} AND payment."allocatedAmount" > 0)`);

    if (query?.clientCode) {
      qb.andWhere('payment.clientCode ILIKE :clientCode', { clientCode: `%${query.clientCode.trim()}%` });
    }

    if (query?.clientName) {
      qb.andWhere('payment.clientName ILIKE :clientName', { clientName: `%${query.clientName.trim()}%` });
    }

    if (query?.createdById) {
      qb.andWhere('payment.createdById = :createdById', { createdById: query.createdById.trim() });
    }

    if (query?.startDate) {
      const start = this.parseDateOnly(query.startDate, { endOfDay: false });
      qb.andWhere('payment.createdAt >= :start', { start });
    }

    if (query?.endDate) {
      const end = this.parseDateOnly(query.endDate, { endOfDay: true });
      qb.andWhere('payment.createdAt <= :end', { end });
    }

    if (query?.search?.trim()) {
      const search = `%${query.search.trim()}%`;
      qb.andWhere(new Brackets((where) => {
        where.where('payment.clientName ILIKE :search', { search })
          .orWhere('payment.clientCode ILIKE :search', { search })
          .orWhere('payment.paymentRef ILIKE :search', { search })
          .orWhere('payment.sourceBank ILIKE :search', { search });
      }));
    }

    qb.orderBy('payment.createdAt', 'DESC')
      .addOrderBy('payment.id', 'DESC');
    return qb;
  }

  private toListItem(payment: Payment): PaymentsListItem {
    const {
      proofUrl,
      fileHash: _fileHash,
      proofDhash: _proofDhash,
      observation: _observation,
      ...item
    } = payment;
    return { ...item, hasProof: !!proofUrl } as PaymentsListItem;
  }

  private assertClaimAllowed(payment: Payment, actor: Actor) {
    const now = new Date();
    const active =
      !!payment.reviewClaimedById &&
      !!payment.reviewClaimExpiresAt &&
      new Date(payment.reviewClaimExpiresAt as any).getTime() > now.getTime();

    if (active && payment.reviewClaimedById !== actor.userId) {
      const who = payment.reviewClaimedByName || payment.reviewClaimedByUsername || payment.reviewClaimedById;
      throw new ConflictException(`Este pago está tomado por: ${who}`);
    }
  }

  private isForeignForCollector(payment: Pick<Payment, 'createdById'>, actor?: Actor) {
    return actor?.role === UserRole.COBRADOR && payment.createdById !== actor.userId;
  }

  /** Pago ajeno visto por un cobrador en el panel compartido: sin comprobante ni datos internos. */
  private toForeignView(payment: Payment): Payment {
    const {
      proofUrl,
      observation: _observation,
      fileHash: _fileHash,
      proofDhash: _proofDhash,
      matchedMovement: _matchedMovement,
      ...rest
    } = payment;
    return { ...rest, hasProof: !!proofUrl } as unknown as Payment;
  }

  private loadWithRelations(id: string) {
    return this.paymentRepo.findOne({ where: { id }, relations: ['createdBy', 'matchedMovement'] });
  }

  private async resolveActorName(manager: EntityManager, actor: Actor) {
    return actor.name ?? (await manager.getRepository(User).findOneBy({ id: actor.userId }))?.name ?? null;
  }

  /** Bloquea la fila y verifica que el pago siga pendiente y no este tomado por otro revisor. */
  private async lockForDecision(manager: EntityManager, id: string, actor: Actor): Promise<Payment> {
    const payment = await manager.getRepository(Payment).findOne({
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!payment) throw new NotFoundException('Pago no encontrado');
    if (!DECIDABLE_STATES.includes(payment.status)) {
      throw new ConflictException('Este pago ya fue resuelto. Anulá la decisión antes de cambiarla.');
    }
    this.assertClaimAllowed(payment, actor);
    return payment;
  }

  async create(data: Partial<Payment>, actor: Actor): Promise<Payment> {
    if (typeof data.isAtlasAccount !== 'boolean') {
      throw new BadRequestException('Elegí el banco donde se depositó: Atlas o BNF.');
    }
    // 1. Check for Duplicate File Hash (ignore RECHAZADO to allow retries)
    if (data.fileHash) {
      const existingHash = await this.paymentRepo.findOne({
        where: {
          fileHash: data.fileHash,
          status: Not(PaymentState.RECHAZADO)
        }
      });
      if (existingHash) {
        throw new ConflictException(`Este comprobante ya existe en el sistema (Ref: ${existingHash.paymentRef})`);
      }
    }

    // 1b) Check for near-duplicate proof image (dHash), anchored by stable fields.
    // This reduces bypass where collectors change text fields but re-send the same proof (WhatsApp recompression, screenshot, etc).
    if (data.proofDhash && data.clientCode && typeof data.amount === 'number' && data.sourceBank) {
      const now = new Date();
      const since = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000); // last 3 days

      const candidates = await this.paymentRepo.createQueryBuilder('p')
        .select(['p.id', 'p.paymentRef', 'p.proofDhash', 'p.createdAt', 'p.status'])
        .where('p.status != :rej', { rej: PaymentState.RECHAZADO })
        .andWhere('p.clientCode = :clientCode', { clientCode: data.clientCode })
        .andWhere('p.sourceBank = :sourceBank', { sourceBank: data.sourceBank })
        .andWhere('p.amount = :amount', { amount: data.amount })
        .andWhere('p.proofDhash IS NOT NULL')
        .andWhere('p.createdAt >= :since', { since })
        .orderBy('p.createdAt', 'DESC')
        .take(40)
        .getMany();

      const threshold = 6; // 0 = identical dhash; <=6 is usually very similar
      for (const c of candidates) {
        if (!c.proofDhash) continue;
        const dist = hammingDistanceHex64(String(data.proofDhash), String(c.proofDhash));

        if (dist <= threshold) {
          // Si el usuario proporcionó una referencia distinta, permitimos que las fotos se parezcan
          // (Es común en el mismo banco/cliente/monto que los comprobantes sean casi idénticos visualmente).
          if (data.paymentRef && c.paymentRef && data.paymentRef !== c.paymentRef) {
            continue;
          }

          throw new ConflictException(
            `Posible comprobante duplicado: ya existe un registro reciente para este cliente/monto/banco (Ref: ${c.paymentRef || c.id.slice(0, 8)}).`,
          );
        }
      }
    }

    // 2. Check for Duplicate Reference (ignore RECHAZADO)
    if (data.paymentRef) {
      const existingRef = await this.paymentRepo.findOne({
        where: {
          paymentRef: data.paymentRef,
          status: Not(PaymentState.RECHAZADO)
        }
      });
      if (existingRef) {
        // Ignore if client is different? No, ref should be unique per system usually?
        // Let's assume unique per system for safety.
        throw new ConflictException(`La referencia ${data.paymentRef} ya esta registrada.`);
      }
    }

    let saved: Payment;
    try {
      saved = await this.paymentRepo.manager.transaction(async (manager) => {
        const paymentRepo = manager.getRepository(Payment);
        const payment = paymentRepo.create({ ...data, createdById: actor.userId });
        const inserted = await paymentRepo.save(payment);
        await this.logAudit({
          action: 'PAYMENT_CREATED',
          userId: actor.userId,
          actorUsername: actor.username,
          before: null,
          after: inserted.status,
          paymentId: inserted.id,
          metadata: JSON.stringify({ amount: inserted.amount, ref: inserted.paymentRef }),
        }, manager);
        return inserted;
      });
    } catch (error) {
      const code = (error as { driverError?: { code?: string }; code?: string })?.driverError?.code ??
        (error as { code?: string })?.code;
      if (code === '23505') {
        throw new ConflictException('La referencia o el comprobante ya fueron registrados por otra operación. Actualizá la lista.');
      }
      throw error;
    }
    return saved;
  }

  /** Corrige una consulta pendiente; en revisión solo un supervisor/admin puede clasificar la cuenta. */
  async updatePayment(
    id: string,
    data: {
      amount?: number;
      paymentRef?: string;
      sourceBank?: string;
      clientCode?: string;
      clientName?: string;
      observation?: string;
      isAtlasAccount?: boolean;
    },
    actor: Actor,
  ): Promise<Payment> {
    return this.paymentRepo.manager.transaction(async (manager) => {
      const paymentRepo = manager.getRepository(Payment);
      // La misma fila se bloquea en confirmación, rechazo y conciliación bancaria.
      // El estado y los montos deben leerse después de adquirir ese bloqueo.
      const payment = await paymentRepo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!payment) throw new NotFoundException('Pago no encontrado.');
      const inReview = payment.status === PaymentState.EN_REVISION;
      if (payment.status !== PaymentState.PENDIENTE_VERIFICACION && !inReview) {
        throw new BadRequestException('Solo se pueden editar pagos pendientes o clasificar la cuenta de una consulta en revisión.');
      }

      const isOwner = payment.createdById === actor.userId;
      const isAdminOrSupervisor = actor.role === UserRole.ADMIN || actor.role === UserRole.SUPERVISOR;
      if ((inReview && !isAdminOrSupervisor) || (!inReview && !isOwner && !isAdminOrSupervisor)) {
        throw new ForbiddenException('No tienes permiso para editar este pago.');
      }
      this.assertClaimAllowed(payment, actor);
      if (inReview && (data.isAtlasAccount === undefined ||
        Object.entries(data).some(([key, value]) => key !== 'isAtlasAccount' && value !== undefined))) {
        throw new BadRequestException('En revisión solo se puede corregir el banco de depósito (Atlas o BNF).');
      }
      // La conciliación usa estos datos como evidencia y conserva un saldo aplicado.
      // No se puede corregir el comprobante por otro camino mientras una toma siga activa.
      if (Number(payment.allocatedAmount) > 0) {
        throw new ConflictException('Esta consulta ya tiene monto conciliado con el banco; anulá la toma antes de editarla.');
      }
      const activeBankClaim = await manager.getRepository(BankTransferClaim).findOne({
        where: { paymentId: payment.id, status: ClaimStatus.ACTIVA },
      });
      if (activeBankClaim) {
        throw new ConflictException('Esta consulta ya tiene una toma bancaria activa; anulala antes de editarla.');
      }
      if (data.isAtlasAccount !== undefined && typeof data.isAtlasAccount !== 'boolean') {
        throw new BadRequestException('El banco de depósito debe ser Atlas o BNF.');
      }

      const newRef = data.paymentRef !== undefined ? data.paymentRef : payment.paymentRef;
      if (data.paymentRef !== undefined && data.paymentRef !== payment.paymentRef) {
        const existingRef = await paymentRepo.findOne({
          where: { paymentRef: newRef, status: Not(PaymentState.RECHAZADO) },
        });
        if (existingRef && existingRef.id !== id) {
          throw new ConflictException(`La referencia ${newRef} ya está registrada en otro pago.`);
        }
      }

      const beforeStatus = payment.status;
      const beforeData = {
        amount: payment.amount,
        paymentRef: payment.paymentRef,
        sourceBank: payment.sourceBank,
        clientCode: payment.clientCode,
        clientName: payment.clientName,
        observation: payment.observation,
        isAtlasAccount: payment.isAtlasAccount,
      };

      if (data.amount !== undefined) payment.amount = data.amount;
      if (data.paymentRef !== undefined) payment.paymentRef = data.paymentRef;
      if (data.sourceBank !== undefined) payment.sourceBank = data.sourceBank;
      if (data.clientCode !== undefined) payment.clientCode = data.clientCode;
      if (data.clientName !== undefined) payment.clientName = data.clientName;
      if (data.observation !== undefined) payment.observation = data.observation;
      if (data.isAtlasAccount !== undefined) payment.isAtlasAccount = data.isAtlasAccount;

      let saved: Payment;
      try {
        saved = await paymentRepo.save(payment);
      } catch (error) {
        if (error instanceof QueryFailedError && (error as any).driverError?.code === '23505' &&
          (error as any).driverError?.constraint === 'uq_payments_payment_ref_active') {
          throw new ConflictException('Esta referencia ya está registrada en otra consulta activa.');
        }
        if (error instanceof QueryFailedError && (error as any).driverError?.code === '23514' &&
          (error as any).driverError?.constraint === 'ck_payments_allocated') {
          throw new ConflictException('El monto no puede quedar por debajo de lo ya conciliado con el banco.');
        }
        throw error;
      }

      await this.logAudit({
        action: 'PAYMENT_UPDATED',
        userId: actor.userId,
        actorUsername: actor.username,
        before: beforeStatus,
        after: saved.status,
        paymentId: saved.id,
        metadata: JSON.stringify({ before: beforeData, after: data }),
      }, manager);

      // Preserva la relación que devolvía el endpoint sin soltar el bloqueo antes de responder.
      return (await paymentRepo.findOne({ where: { id: saved.id }, relations: ['createdBy'] })) ?? saved;
    });
  }

  async findAll(query?: ListPaymentsQueryDto, actor?: Actor): Promise<PaymentsListItem[]> {
    const scopedQuery = enforcePaymentsListScope(query, actor);
    const qb = this.buildPaymentsListQuery(scopedQuery);
    const rawLimit = scopedQuery.limit;
    const rawOffset = scopedQuery.offset;
    const limit = Number.isFinite(rawLimit) && (rawLimit as number) > 0
      ? Math.min(rawLimit as number, 2000)
      : undefined;
    const offset = Number.isFinite(rawOffset) && (rawOffset as number) >= 0
      ? (rawOffset as number)
      : undefined;
    if (limit) qb.take(limit);
    if (offset) qb.skip(offset);
    return (await attachPaymentControls(this.paymentRepo.manager, await qb.getMany())).map((payment) => this.toListItem(payment));
  }

  async findAllPaged(query?: ListPaymentsQueryDto, actor?: Actor): Promise<PaymentsListResult> {
    const scopedQuery = enforcePaymentsListScope(query, actor);
    const { page, pageSize, offset } = normalizePaymentsPage(scopedQuery);

    const qb = this.buildPaymentsListQuery(scopedQuery)
      .take(pageSize)
      .skip(offset);

    const [items, total] = await qb.getManyAndCount();
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    return {
      items: (await attachPaymentControls(this.paymentRepo.manager, items)).map((payment) => this.toListItem(payment)),
      total,
      page,
      pageSize,
      totalPages,
    };
  }

  async findOne(id: string, actor?: Actor): Promise<Payment | null> {
    const payment = await this.loadWithRelations(id);
    if (payment) await attachPaymentControls(this.paymentRepo.manager, [payment]);
    if (payment && this.isForeignForCollector(payment, actor)) {
      return this.toForeignView(payment);
    }
    return payment;
  }

  async confirmManual(id: string, reason: string | undefined, actor: Actor): Promise<Payment> {
    const saved = await this.paymentRepo.manager.transaction(async (manager) => {
      const payment = await this.lockForDecision(manager, id, actor);
      if (payment.isAtlasAccount == null) {
        throw new ConflictException('Elegí el banco de depósito (Atlas o BNF) antes de aprobar la consulta. Podés editarla mientras esté pendiente.');
      }
      if (payment.isAtlasAccount) {
        throw new ConflictException('Una cuenta Atlas solo se aprueba al conciliar un movimiento existente en el panel bancario; no se permite la aprobación manual.');
      }
      if (Number(payment.allocatedAmount) > 0) {
        throw new ConflictException('Esta consulta ya está cubierta parcialmente por el banco. Terminá o anulá la conciliación antes de decidirla.');
      }
      const activeBankClaim = await manager.getRepository(BankTransferClaim).findOne({
        where: { paymentId: payment.id, status: ClaimStatus.ACTIVA },
      });
      if (activeBankClaim) {
        throw new ConflictException(`Esta consulta ya tiene una conciliación bancaria activa (${activeBankClaim.receiptNumber}). Revisala desde el panel del banco.`);
      }

      const normalizedReason = typeof reason === 'string' && reason.trim() ? reason.trim() : null;
      // Solo llega BNF a esta vía. El feed registra ingresos a otra cuenta (Atlas): un monto,
      // cliente o referencia repetidos allí no identifican este depósito. Las conciliaciones
      // activas de ESTA consulta ya se descartaron bajo bloqueo, antes de permitir la decisión.
      const actorName = await this.resolveActorName(manager, actor);

      const before = payment.status;
      this.clearReviewClaim(payment);
      payment.status = PaymentState.CONFIRMADO_MANUAL;
      payment.verifiedById = actor.userId;
      payment.verifiedByUsername = actor.username ?? null;
      payment.verifiedByName = actorName;
      payment.verifiedAt = new Date();
      payment.decisionReason = normalizedReason;
      payment.rejectionReason = null as any;
      if (normalizedReason) {
        payment.observation = (payment.observation || '') + ` [Manual: ${normalizedReason}]`;
      }
      const saved = await manager.getRepository(Payment).save(payment);
      await this.logAudit({
        action: 'PAYMENT_CONFIRMED_MANUAL',
        userId: actor.userId,
        actorUsername: actor.username,
        before,
        after: saved.status,
        paymentId: saved.id,
        metadata: JSON.stringify({
          reason: normalizedReason,
          amount: saved.amount,
          isAtlasAccount: payment.isAtlasAccount ?? null,
        }),
      }, manager);
      return saved;
    });
    return (await this.loadWithRelations(saved.id)) ?? saved;
  }

  async reject(id: string, reason: string | undefined, actor: Actor): Promise<Payment> {
    const saved = await this.paymentRepo.manager.transaction(async (manager) => {
      const payment = await this.lockForDecision(manager, id, actor);
      if (Number(payment.allocatedAmount) > 0) {
        throw new ConflictException('Esta consulta ya tiene monto conciliado con el banco; anulá la toma antes de rechazarla.');
      }
      const activeBankClaim = await manager.getRepository(BankTransferClaim).findOne({
        where: { paymentId: payment.id, status: ClaimStatus.ACTIVA },
      });
      if (activeBankClaim) {
        throw new ConflictException(`Esta consulta tiene una toma bancaria activa (${activeBankClaim.receiptNumber}). Anulala antes de rechazar.`);
      }

      const before = payment.status;
      this.clearReviewClaim(payment);
      payment.status = PaymentState.RECHAZADO;
      const normalizedReason = typeof reason === 'string' && reason.trim() ? reason.trim() : null;
      payment.decisionReason = normalizedReason;
      payment.rejectionReason = normalizedReason as any;
      const saved = await manager.getRepository(Payment).save(payment);
      await this.logAudit({
        action: 'PAYMENT_REJECTED',
        userId: actor.userId,
        actorUsername: actor.username,
        before,
        after: saved.status,
        paymentId: saved.id,
        metadata: JSON.stringify({ reason: normalizedReason, amount: saved.amount }),
      }, manager);
      return saved;
    });
    return (await this.loadWithRelations(saved.id)) ?? saved;
  }

  async undoDecision(id: string, actor: Actor): Promise<Payment> {
    const saved = await this.paymentRepo.manager.transaction(async (manager) => {
      const paymentRepo = manager.getRepository(Payment);
      const payment = await paymentRepo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!payment) throw new NotFoundException('Pago no encontrado');

      const decidedStatuses = [PaymentState.CONFIRMADO, PaymentState.CONFIRMADO_MANUAL, PaymentState.RECHAZADO];
      if (!decidedStatuses.includes(payment.status)) {
        throw new ConflictException('Solo se puede anular una transferencia ya resuelta.');
      }

      if (payment.cashPaidAt) {
        throw new ConflictException('No se puede anular: el pago ya fue marcado como caja.');
      }

      if (payment.printedAt) {
        throw new ConflictException('No se puede anular: el ticket ya fue impreso.');
      }

      // Conciliada con una transferencia del banco: se anula desde el panel de transferencias,
      // que libera la transferencia y la consulta juntas y deja el motivo auditado.
      const bankClaim = await manager.getRepository(BankTransferClaim).findOne({
        where: { paymentId: payment.id, status: ClaimStatus.ACTIVA },
      });
      if (bankClaim) {
        throw new ConflictException(
          `Esta consulta está conciliada con la transferencia bancaria ${bankClaim.receiptNumber}. Anulá la conciliación desde el panel de transferencias.`,
        );
      }

      const before = payment.status;
      this.clearReviewClaim(payment);

      const previous = {
        status: payment.status,
        verifiedById: payment.verifiedById ?? null,
        verifiedByUsername: payment.verifiedByUsername ?? null,
        verifiedByName: payment.verifiedByName ?? null,
        verifiedAt: payment.verifiedAt ? new Date(payment.verifiedAt as any).toISOString() : null,
        decisionReason: payment.decisionReason ?? null,
        rejectionReason: payment.rejectionReason ?? null,
        matchedMovementId: payment.matchedMovementId ?? null,
      };

      // Liberar el movimiento conciliado: si no, queda marcado como usado para siempre.
      if (payment.matchedMovementId) {
        const movementRepo = manager.getRepository(Movement);
        const movement = await movementRepo.findOne({
          where: { id: payment.matchedMovementId },
          lock: { mode: 'pessimistic_write' },
        });
        if (movement?.isReconciled) {
          movement.isReconciled = false;
          await movementRepo.save(movement);
        }
      }

      payment.status = PaymentState.PENDIENTE_VERIFICACION;
      payment.verifiedById = null as any;
      payment.verifiedByUsername = null as any;
      payment.verifiedByName = null as any;
      payment.verifiedAt = null as any;
      payment.decisionReason = null;
      payment.rejectionReason = null as any;
      payment.matchedMovementId = null as any;
      (payment as any).matchedMovement = null;

      const saved = await paymentRepo.save(payment);

      await this.logAudit({
        action: 'PAYMENT_DECISION_UNDONE',
        userId: actor.userId,
        actorUsername: actor.username,
        before,
        after: saved.status,
        paymentId: saved.id,
        metadata: JSON.stringify(previous),
      }, manager);
      return saved;
    });
    return (await this.loadWithRelations(saved.id)) ?? saved;
  }

  /**
   * El ticket va a abrirse en el dialogo de impresion. No lo marca como impreso: el navegador no sabe
   * si la persona imprimio o cancelo, eso lo confirma despues `markAsPrinted`. Queda auditado que se
   * abrio el dialogo, para ver aperturas que nadie confirmo.
   */
  async openPrintDialog(id: string, actor: Actor, reason?: string): Promise<Payment & { printAuthorizationId: string; printCopyNumber: number; reprintReason: string | null }> {
    return this.paymentRepo.manager.transaction(async (manager) => {
    const payment = await manager.getRepository(Payment).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!payment) throw new NotFoundException('Pago no encontrado');
    if (actor.role === UserRole.COBRADOR && payment.createdById !== actor.userId) {
      throw new ForbiddenException('No tienes permiso para imprimir pagos de otros usuarios.');
    }
    if (![PaymentState.CONFIRMADO, PaymentState.CONFIRMADO_MANUAL].includes(payment.status)) {
      throw new ConflictException('Solo se puede imprimir el ticket de pagos confirmados.');
    }
    if (![UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.COBRADOR].includes(actor.role as UserRole)) throw new ForbiddenException('No tenés permiso para imprimir tickets.');
    const grant = await authorizePrint(manager, this.paymentPrintTarget(payment.id), actor, payment.printedAt ? 1 : 0, reason);
    const full = await manager.getRepository(Payment).findOne({ where: { id }, relations: ['createdBy', 'matchedMovement'] });
    return { ...(full ?? payment), printAuthorizationId: grant.authorizationId, printCopyNumber: grant.copyNumber, reprintReason: grant.reprintReason, ticketIssued: true };
    });
  }

  private paymentPrintTarget(id: string): PrintTarget {
    return { scopeKey: `PAYMENT:${id}`, paymentId: id, openAction: 'PAYMENT_PRINT_OPENED', printAction: 'PAYMENT_PRINTED' };
  }

  /** La persona confirmo que el ticket salio impreso. */
  async markAsPrinted(id: string, actor?: Actor, authorizationId?: string): Promise<Payment> {
    const saved = await this.paymentRepo.manager.transaction(async (manager) => {
      const paymentRepo = manager.getRepository(Payment);
      const payment = await paymentRepo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!payment) throw new NotFoundException('Pago no encontrado');

      if (actor?.role === UserRole.COBRADOR && payment.createdById !== actor.userId) {
        throw new ForbiddenException('No tienes permiso para imprimir pagos de otros usuarios.');
      }

      if (![PaymentState.CONFIRMADO, PaymentState.CONFIRMADO_MANUAL].includes(payment.status)) {
        throw new ConflictException('Solo se puede registrar la impresión de pagos confirmados.');
      }
      if (!actor || ![UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.COBRADOR].includes(actor.role as UserRole)) throw new ForbiddenException('No tenés permiso para imprimir tickets.');
      const grant = await checkPrintAuthorization(manager, this.paymentPrintTarget(id), actor, authorizationId);
      if (grant.confirmed) return payment;
      payment.printedAt ??= new Date();

      // Backfill verified-by info if missing (for older records)
      if (!payment.verifiedAt) {
        const verificationActions = [
          'PAYMENT_MATCH_CONFIRMED',
          'PAYMENT_CONFIRMED_MANUAL',
          'PAYMENT_AUTO_CONFIRMED',
        ];

        const last = await manager.getRepository(AuditLog).findOne({
          where: { paymentId: payment.id, action: In(verificationActions) } as any,
          order: { timestamp: 'DESC' },
        });

        if (last && verificationActions.includes(last.action)) {
          const resolvedName =
            last.userId === 'system-auto'
              ? 'Sistema'
              : (await manager.getRepository(User).findOneBy({ id: last.userId }))?.name ?? null;
          payment.verifiedById = last.userId || null as any;
          payment.verifiedByUsername = last.actorUsername || null;
          payment.verifiedByName = resolvedName || last.actorUsername || null;
          payment.verifiedAt = last.timestamp ? new Date(last.timestamp as any) : new Date();
        }
      }
      const saved = await paymentRepo.save(payment);
      await this.logAudit({
        action: 'PAYMENT_PRINTED',
        userId: actor?.userId,
        actorUsername: actor?.username,
        before: payment.status,
        after: payment.status,
        paymentId: payment.id,
        metadata: JSON.stringify({ authorizationId: grant.authorizationId, copyNumber: grant.copyNumber, reason: grant.reprintReason }),
      }, manager);
      return saved;
    });
    return (await this.loadWithRelations(saved.id)) ?? saved;
  }

  async markCashPaid(id: string, actor: Actor): Promise<Payment> {
    const payment = await this.findOne(id);
    if (!payment) throw new NotFoundException('Pago no encontrado');

    // Cash is marked by the collector (cobrador) under good faith; but must only allow marking its own payments.
    if (actor.role === UserRole.COBRADOR && payment.createdById && payment.createdById !== actor.userId) {
      throw new ForbiddenException('No podés marcar caja en un pago que no te pertenece.');
    }

    if (payment.status === PaymentState.RECHAZADO) {
      throw new ConflictException('No se puede marcar caja en un pago rechazado.');
    }

    if (![PaymentState.CONFIRMADO, PaymentState.CONFIRMADO_MANUAL].includes(payment.status)) {
      throw new ConflictException('Solo se puede marcar caja en pagos confirmados.');
    }

    if (!payment.printedAt) {
      throw new ConflictException('Primero debe imprimirse el ticket.');
    }

    if (payment.cashPaidAt) {
      return payment;
    }

    const actorName =
      actor.name ?? (await this.paymentRepo.manager.getRepository(User).findOneBy({ id: actor.userId }))?.name ?? null;

    payment.cashPaidAt = new Date();
    payment.cashPaidById = actor.userId;
    payment.cashPaidByUsername = actor.username ?? null;
    payment.cashPaidByName = actorName ?? null;

    const saved = await this.paymentRepo.save(payment);
    await this.logAudit({
      action: 'PAYMENT_CASH_PAID',
      userId: actor.userId,
      actorUsername: actor.username,
      before: saved.status,
      after: saved.status,
      paymentId: saved.id,
    });

    return saved;
  }

  async listReviewQueue(
    params: { limit?: number; onlyMine?: boolean },
    actor: Actor,
  ): Promise<Payment[]> {
    const safeLimit = Math.max(1, Math.min(200, Number(params.limit) || 80));
    const now = new Date();

    const qb = this.paymentRepo.createQueryBuilder('p')
      .leftJoinAndSelect('p.createdBy', 'createdBy')
      .where('p.status IN (:...statuses)', { statuses: [PaymentState.PENDIENTE_VERIFICACION, PaymentState.EN_REVISION] })
      .orderBy('p.createdAt', 'ASC')
      .take(safeLimit);

    if (params.onlyMine) {
      qb.andWhere('p.reviewClaimedById = :uid', { uid: actor.userId })
        .andWhere('p.reviewClaimExpiresAt IS NOT NULL')
        .andWhere('p.reviewClaimExpiresAt > :now', { now });
    }

    return qb.getMany();
  }

  async claimReview(paymentId: string, actor: Actor): Promise<Payment> {
    return this.paymentRepo.manager.transaction(async (manager) => {
      const paymentRepo = manager.getRepository(Payment);
      const auditRepo = manager.getRepository(AuditLog);
      const userRepo = manager.getRepository(User);

      const payment = await paymentRepo.findOne({
        where: { id: paymentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) throw new NotFoundException('Pago no encontrado');

      if ([PaymentState.CONFIRMADO, PaymentState.CONFIRMADO_MANUAL, PaymentState.RECHAZADO].includes(payment.status)) {
        throw new ConflictException('Este pago ya fue resuelto.');
      }

      const now = new Date();
      const active =
        !!payment.reviewClaimedById &&
        !!payment.reviewClaimExpiresAt &&
        new Date(payment.reviewClaimExpiresAt as any).getTime() > now.getTime();

      if (active && payment.reviewClaimedById !== actor.userId) {
        const who = payment.reviewClaimedByName || payment.reviewClaimedByUsername || payment.reviewClaimedById;
        throw new ConflictException(`Este pago ya está tomado por: ${who}`);
      }

      const actorName = actor.name ?? (await userRepo.findOneBy({ id: actor.userId }))?.name ?? null;
      payment.reviewClaimedById = actor.userId;
      payment.reviewClaimedByUsername = actor.username ?? null;
      payment.reviewClaimedByName = actorName ?? null;
      payment.reviewClaimedAt = now;
      payment.reviewClaimExpiresAt = new Date(now.getTime() + 15 * 60 * 1000);

      const saved = await paymentRepo.save(payment);

      await auditRepo.save(auditRepo.create({
        action: 'PAYMENT_REVIEW_CLAIMED',
        userId: actor.userId,
        actorUsername: actor.username ?? null,
        beforeState: saved.status,
        afterState: saved.status,
        paymentId: saved.id,
        metadata: JSON.stringify({
          expiresAt: (saved.reviewClaimExpiresAt as any) ?? null,
        }),
      }));

      const full = await paymentRepo.findOne({ where: { id: saved.id }, relations: ['createdBy', 'matchedMovement'] });
      return full || saved;
    });
  }

  async releaseReview(paymentId: string, actor: Actor): Promise<Payment> {
    return this.paymentRepo.manager.transaction(async (manager) => {
      const paymentRepo = manager.getRepository(Payment);
      const auditRepo = manager.getRepository(AuditLog);

      const payment = await paymentRepo.findOne({
        where: { id: paymentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) throw new NotFoundException('Pago no encontrado');

      const now = new Date();
      const active =
        !!payment.reviewClaimedById &&
        !!payment.reviewClaimExpiresAt &&
        new Date(payment.reviewClaimExpiresAt as any).getTime() > now.getTime();

      if (active && payment.reviewClaimedById !== actor.userId) {
        const who = payment.reviewClaimedByName || payment.reviewClaimedByUsername || payment.reviewClaimedById;
        throw new ConflictException(`Este pago está tomado por: ${who}`);
      }

      this.clearReviewClaim(payment);
      const saved = await paymentRepo.save(payment);

      await auditRepo.save(auditRepo.create({
        action: 'PAYMENT_REVIEW_RELEASED',
        userId: actor.userId,
        actorUsername: actor.username ?? null,
        beforeState: saved.status,
        afterState: saved.status,
        paymentId: saved.id,
      }));

      const full = await paymentRepo.findOne({ where: { id: saved.id }, relations: ['createdBy', 'matchedMovement'] });
      return full || saved;
    });
  }

  async getAuditForPayment(paymentId: string, actor?: Actor) {
    const logs = await this.auditRepo.find({
      where: { paymentId },
      order: { timestamp: 'DESC' },
    });
    if (actor?.role !== UserRole.COBRADOR) return this.withAuditContext(logs);

    const payment = await this.paymentRepo.findOne({ where: { id: paymentId }, select: ['id', 'createdById'] });
    if (payment && !this.isForeignForCollector(payment, actor)) return this.withAuditContext(logs, { payments: false });
    // Linea de vida de un pago ajeno: acciones, autores y estados, sin metadatos (motivos, datos editados).
    return this.withAuditContext(logs.map((log) => ({ ...log, metadata: null })), { payments: false });
  }

  async listAudit(query: AuditQueryDto) {
    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;

    const qb = this.auditRepo.createQueryBuilder('a')
      .orderBy('a.timestamp', 'DESC')
      .take(limit)
      .skip(offset);

    if (query.startDate) {
      const start = new Date(query.startDate);
      start.setHours(0, 0, 0, 0);
      qb.andWhere('a.timestamp >= :start', { start });
    }

    if (query.endDate) {
      const end = new Date(query.endDate);
      end.setHours(23, 59, 59, 999);
      qb.andWhere('a.timestamp <= :end', { end });
    }

    if (query.action) qb.andWhere('a.action = :action', { action: query.action });
    if (query.actorUsername) qb.andWhere('a.actorUsername = :actorUsername', { actorUsername: query.actorUsername });
    if (query.userId) qb.andWhere('a.userId = :userId', { userId: query.userId });
    if (query.paymentId) qb.andWhere('a.paymentId = :paymentId', { paymentId: query.paymentId });
    if (query.movementId) qb.andWhere('a.movementId = :movementId', { movementId: query.movementId });
    if (query.targetUserId) qb.andWhere('a.targetUserId = :targetUserId', { targetUserId: query.targetUserId });

    const [items, total] = await qb.getManyAndCount();
    return { total, items: await this.withAuditContext(items), limit, offset };
  }

  async logProofViewed(paymentId: string, actor: Actor) {
    const payment = await this.paymentRepo.findOne({
      where: { id: paymentId },
      select: ['id', 'amount', 'clientCode', 'paymentRef', 'sourceBank', 'createdById'],
    });
    if (!payment) throw new NotFoundException('Pago no encontrado');
    if (this.isForeignForCollector(payment, actor)) {
      throw new ForbiddenException('No podés registrar la lectura de un comprobante ajeno.');
    }

    await this.logAudit({
      action: 'PAYMENT_PROOF_VIEWED',
      userId: actor.userId,
      actorUsername: actor.username,
      paymentId,
      metadata: JSON.stringify({
          amount: payment.amount,
          clientCode: payment.clientCode,
          ref: payment.paymentRef,
          bank: payment.sourceBank,
          createdById: payment.createdById,
        }),
    });

    return { ok: true };
  }

  async listProofViews(limit = 50, actor?: Actor) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const logs = await this.auditRepo.find({
      where: { action: 'PAYMENT_PROOF_VIEWED' },
      order: { timestamp: 'DESC' },
      take: safeLimit,
    });
    return this.attachPaymentInfo(logs, actor);
  }

  async listActivity(limit = 80, actor?: Actor) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 80));
    const actions = [
      'PAYMENT_CREATED',
      'PAYMENT_SENT_TO_REVIEW',
      'PAYMENT_REVIEW_CLAIMED',
      'PAYMENT_REVIEW_RELEASED',
      'PAYMENT_PROOF_VIEWED',
      'PAYMENT_CONFIRMED_MANUAL',
      'PAYMENT_MATCH_CONFIRMED',
      'PAYMENT_AUTO_CONFIRMED',
      'PAYMENT_REJECTED',
      'PAYMENT_DECISION_UNDONE',
      'MATCHING_TRIGGERED',
      'PAYMENT_PRINTED',
      'PAYMENT_CASH_PAID',
      'PAYMENT_BANK_RECONCILED',
      'PAYMENT_BANK_RECONCILIATION_VOIDED',
    ];

    const logs = await this.auditRepo.find({
      where: { action: In(actions) } as any,
      order: { timestamp: 'DESC' },
      take: safeLimit,
    });

    return this.attachPaymentInfo(logs, actor);
  }

  async getSummary(startDate?: string, endDate?: string) {
    const qb = this.paymentRepo.createQueryBuilder('payment')
      .select('payment.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .addSelect('SUM(payment.amount)', 'total')
      .groupBy('payment.status');

    if (startDate) {
      const start = this.parseDateOnly(startDate, { endOfDay: false });
      qb.andWhere('payment.createdAt >= :start', { start });
    }

    if (endDate) {
      const end = this.parseDateOnly(endDate, { endOfDay: true });
      qb.andWhere('payment.createdAt <= :end', { end });
    }

    const rows = await qb.getRawMany();

    return rows.map(r => ({
      status: r.status as PaymentState,
      count: Number(r.count) || 0,
      total: Number(r.total) || 0,
    }));
  }

  async getKpis(params?: { startDate?: string; endDate?: string; overdueMinutes?: number }) {
    const now = new Date();
    const overdueMinutes = Math.max(1, Math.min(240, Number(params?.overdueMinutes) || 10));

    const start = params?.startDate
      ? this.parseDateOnly(params.startDate, { endOfDay: false })
      : new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

    const end = params?.endDate
      ? this.parseDateOnly(params.endDate, { endOfDay: true })
      : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const pendingStatuses = [PaymentState.PENDIENTE_VERIFICACION, PaymentState.EN_REVISION];
    const overdueAt = new Date(now.getTime() - overdueMinutes * 60 * 1000);

    const [pendingCount, overdueCount, claimedCount] = await Promise.all([
      this.paymentRepo.count({ where: { status: In(pendingStatuses) } as any }),
      this.paymentRepo.count({ where: { status: In(pendingStatuses), createdAt: LessThan(overdueAt) } as any }),
      this.paymentRepo.createQueryBuilder('p')
        .where('p.status IN (:...statuses)', { statuses: pendingStatuses })
        .andWhere('p.reviewClaimedById IS NOT NULL')
        .andWhere('p.reviewClaimExpiresAt IS NOT NULL')
        .andWhere('p.reviewClaimExpiresAt > :now', { now })
        .getCount(),
    ]);

    const decisionActions = [
      'PAYMENT_CONFIRMED_MANUAL',
      'PAYMENT_MATCH_CONFIRMED',
      'PAYMENT_AUTO_CONFIRMED',
      'PAYMENT_REJECTED',
    ];

    const rows = await this.auditRepo.createQueryBuilder('a')
      .leftJoin(Payment, 'p', 'p.id = a.paymentId')
      .select([
        'a.action AS action',
        'a.userId AS reviewerId',
        'a.actorUsername AS reviewerUsername',
        'a.paymentId AS paymentId',
        'a.timestamp AS decidedAt',
        'a.metadata AS metadata',
        'p.createdAt AS createdAt',
        'p.createdById AS createdById',
        'p.amount AS amount',
      ])
      .where('a.action IN (:...actions)', { actions: decisionActions })
      .andWhere('a.paymentId IS NOT NULL')
      .andWhere('a.timestamp >= :start', { start })
      .andWhere('a.timestamp <= :end', { end })
      .getRawMany();

    // El ranking del cobrador corresponde a los cobros que registró durante
    // el período, no a la fecha en que otra persona los aprobó. Sin esta
    // consulta, los cobros de fin de mes aprobados después desaparecen del mes.
    const resolvedStatuses = [
      PaymentState.CONFIRMADO,
      PaymentState.CONFIRMADO_MANUAL,
      PaymentState.RECHAZADO,
    ];
    const collectorRows = await this.paymentRepo.createQueryBuilder('payment')
      .select([
        'payment.createdById AS createdById',
        'payment.amount AS amount',
        'payment.status AS status',
        'payment.createdAt AS createdAt',
        'payment.verifiedAt AS verifiedAt',
      ])
      .where('payment.createdAt >= :start', { start })
      .andWhere('payment.createdAt <= :end', { end })
      .andWhere('payment.createdById IS NOT NULL')
      .andWhere('payment.status IN (:...statuses)', { statuses: resolvedStatuses })
      .getRawMany();

    const getRawValue = (raw: Record<string, unknown>, key: string) =>
      raw[key] ?? raw[key.toLowerCase()] ?? raw[`a_${key}`] ?? raw[`p_${key}`]
      ?? raw[`a_${key.toLowerCase()}`] ?? raw[`p_${key.toLowerCase()}`];

    const reviewerIds = new Set<string>();
    const collectorIds = new Set<string>();
    for (const r of rows) {
      const rid = getRawValue(r as Record<string, unknown>, 'reviewerId') ?? null;
      const cid = getRawValue(r as Record<string, unknown>, 'createdById') ?? null;
      if (rid) reviewerIds.add(String(rid));
      if (cid) collectorIds.add(String(cid));
    }
    for (const r of collectorRows) {
      const cid = getRawValue(r as Record<string, unknown>, 'createdById') ?? null;
      if (cid) collectorIds.add(String(cid));
    }

    const combinedIds = Array.from(new Set([...reviewerIds, ...collectorIds]));
    const userRepo = this.paymentRepo.manager.getRepository(User);
    const users = combinedIds.length
      ? await userRepo.find({
        where: { id: In(combinedIds) } as any,
        select: ['id', 'name', 'username', 'role'],
      })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    const byReviewer = new Map<string, { userId: string; username: string | null; name: string | null; decisions: number; approved: number; rejected: number; sumMinutes: number; withTime: number; sumApproved: number; sumRejected: number }>();
    const byCollector = new Map<string, { userId: string; username: string | null; name: string | null; submittedResolved: number; approved: number; rejected: number; sumMinutes: number; withTime: number; sumApproved: number; sumRejected: number }>();


    let approved = 0;
    let rejected = 0;
    let sumMinutes = 0;
    let withTime = 0;

    for (const raw of rows) {
      // Helper to pick fields regardless of case (TypeORM getRawMany often lowercases aliases)
      const get = (key: string) => raw[key] ?? raw[key.toLowerCase()] ?? raw[`a_${key}`] ?? raw[`p_${key}`] ?? raw[`a_${key.toLowerCase()}`] ?? raw[`p_${key.toLowerCase()}`];

      const reviewerId = String(get('reviewerId') ?? '');
      const reviewerUsername = (get('reviewerUsername') ?? null) as string | null;
      const action = String(get('action'));
      let amount = Number(get('amount') || 0);

      // Recuperación de monto histórico desde metadata si el join no trajo el valor (pago borrado o metadata legacy)
      const metadata = get('metadata');
      if ((!amount || amount === 0) && metadata) {
        try {
          const meta = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
          if (meta && meta.amount) {
            amount = Number(meta.amount);
          }
        } catch { /* ignore */ }
      }

      const decidedAt = get('decidedAt');
      const createdAt = get('createdAt');
      const decidedDate = decidedAt ? new Date(decidedAt) : null;
      const createdDate = createdAt ? new Date(createdAt) : null;
      const minutes = (decidedDate && createdDate) ? Math.max(0, (decidedDate.getTime() - createdDate.getTime()) / 60000) : null;

      const isApproved = action !== 'PAYMENT_REJECTED';
      if (isApproved) approved += 1; else rejected += 1;
      if (typeof minutes === 'number' && Number.isFinite(minutes)) { sumMinutes += minutes; withTime += 1; }

      if (reviewerId) {
        const u = userById.get(reviewerId);
        const rec = byReviewer.get(reviewerId) ?? {
          userId: reviewerId,
          username: u?.username ?? reviewerUsername ?? null,
          name: u?.name ?? null,
          decisions: 0,
          approved: 0,
          rejected: 0,
          sumMinutes: 0,
          withTime: 0,
          sumApproved: 0,
          sumRejected: 0,
        };
        rec.decisions += 1;
        if (isApproved) {
          rec.approved += 1;
          rec.sumApproved += amount;
        } else {
          rec.rejected += 1;
          rec.sumRejected += amount;
        }
        if (typeof minutes === 'number' && Number.isFinite(minutes)) { rec.sumMinutes += minutes; rec.withTime += 1; }
        byReviewer.set(reviewerId, rec);
      }

    }

    for (const raw of collectorRows) {
      const createdById = String(getRawValue(raw as Record<string, unknown>, 'createdById') ?? '');
      if (!createdById) continue;

      const status = getRawValue(raw as Record<string, unknown>, 'status') as PaymentState;
      const amount = Number(getRawValue(raw as Record<string, unknown>, 'amount') || 0);
      const createdAt = getRawValue(raw as Record<string, unknown>, 'createdAt');
      const verifiedAt = getRawValue(raw as Record<string, unknown>, 'verifiedAt');
      const createdDate = createdAt ? new Date(createdAt as string | number) : null;
      const verifiedDate = verifiedAt ? new Date(verifiedAt as string | number) : null;
      const minutes = (createdDate && verifiedDate)
        ? Math.max(0, (verifiedDate.getTime() - createdDate.getTime()) / 60000)
        : null;
      const isApproved = status === PaymentState.CONFIRMADO || status === PaymentState.CONFIRMADO_MANUAL;

      const u = userById.get(createdById);
      const rec = byCollector.get(createdById) ?? {
        userId: createdById,
        username: u?.username ?? null,
        name: u?.name ?? null,
        submittedResolved: 0,
        approved: 0,
        rejected: 0,
        sumMinutes: 0,
        withTime: 0,
        sumApproved: 0,
        sumRejected: 0,
      };
      rec.submittedResolved += 1;
      if (isApproved) {
        rec.approved += 1;
        rec.sumApproved += amount;
      } else {
        rec.rejected += 1;
        rec.sumRejected += amount;
      }
      if (typeof minutes === 'number' && Number.isFinite(minutes)) { rec.sumMinutes += minutes; rec.withTime += 1; }
      byCollector.set(createdById, rec);
    }

    const reviewerList = Array.from(byReviewer.values())
      .map((r) => ({
        userId: r.userId,
        username: r.username,
        name: r.name,
        decisions: r.decisions,
        approved: r.approved,
        rejected: r.rejected,
        sumApproved: r.sumApproved,
        sumRejected: r.sumRejected,
        avgMinutes: r.withTime ? Number((r.sumMinutes / r.withTime).toFixed(1)) : null,
      }))
      .sort((a, b) => b.decisions - a.decisions);

    const collectorList = Array.from(byCollector.values())
      .map((r) => ({
        userId: r.userId,
        username: r.username,
        name: r.name,
        resolved: r.submittedResolved,
        approved: r.approved,
        rejected: r.rejected,
        sumApproved: r.sumApproved,
        sumRejected: r.sumRejected,
        avgMinutes: r.withTime ? Number((r.sumMinutes / r.withTime).toFixed(1)) : null,
      }))
      .sort((a, b) => b.sumApproved - a.sumApproved || b.resolved - a.resolved);


    return {
      now: {
        pending: pendingCount,
        overdue: overdueCount,
        claimed: claimedCount,
        overdueMinutes,
      },
      period: {
        start: start.toISOString(),
        end: end.toISOString(),
        decisions: rows.length,
        approved,
        rejected,
        avgMinutes: withTime ? Number((sumMinutes / withTime).toFixed(1)) : null,
      },
      byReviewer: reviewerList,
      byCollector: collectorList,
    };
  }
}
