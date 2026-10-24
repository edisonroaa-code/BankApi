/**
 * Carrera opt-in sobre un PostgreSQL descartable creado para la prueba.
 * Requiere un contenedor descartable, una base exclusiva y un marcador con su ID.
 * Nunca lee DB_* ni sincroniza antes de verificar el marcador.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AuditLog } from '../payments/entities/audit-log.entity';
import { Payment, PaymentState } from '../payments/entities/payment.entity';
import { Movement } from '../movements/entities/movement.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { BankTransfersService } from './bank-transfers.service';
import { BankTransferClaim, ClaimReferenceType, ClaimStatus } from './entities/bank-transfer-claim.entity';
import { BankTransfer, BankTransferSource, BankTransferStatus } from './entities/bank-transfer.entity';
import { PaymentsService } from '../payments/payments.service';

const containerId = process.env.BANK_VOID_TEST_CONTAINER_ID ?? '';
const testDb = process.env.BANK_VOID_TEST_PG_DB ?? '';
const port = Number(process.env.BANK_VOID_TEST_PG_PORT);
const enabled = process.env.BANK_VOID_TEST_EPHEMERAL === 'yes' &&
  /^[0-9a-f]{64}$/.test(containerId) &&
  testDb === `bank_void_race_${containerId.slice(0, 12)}` &&
  Number.isInteger(port) && port > 1024 && port !== 5432 && port <= 65535;
const admin = { userId: 'admin-1', username: 'admin', name: 'Administrador', role: UserRole.ADMIN };
const cashier = { userId: 'cashier-1', username: 'cashier', name: 'Caja', role: UserRole.CAJERO };

(enabled ? describe : describe.skip)('BankTransfersService.void con PostgreSQL efímero', () => {
  let dataSource: DataSource;
  let service: BankTransfersService;

  beforeAll(async () => {
    jest.setTimeout(30000);
    const connection = {
      type: 'postgres' as const, host: '127.0.0.1', port,
      username: 'postgres', database: testDb, migrationsRun: false,
      entities: [User, Movement, Payment, AuditLog, BankTransfer, BankTransferClaim],
    };
    const probe = new DataSource({ ...connection, synchronize: false });
    await probe.initialize();
    try {
      const rows = await probe.query('SELECT container_id FROM __bank_void_race_marker LIMIT 1');
      if (rows.length !== 1 || rows[0].container_id !== containerId) {
        throw new Error('Marcador de base efímera ausente o no coincidente; se niega synchronize.');
      }
    } finally {
      await probe.destroy();
    }
    dataSource = new DataSource({ ...connection, synchronize: true });
    await dataSource.initialize();
    await dataSource.query('CREATE SEQUENCE IF NOT EXISTS bank_transfer_receipt_seq');
    const gateway = { emitToRoom: jest.fn(), emitPaymentsChanged: jest.fn() };
    service = new BankTransfersService(dataSource, gateway as any, {} as any);
  }, 30000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  const seed = async () => {
    const transfer = await dataSource.getRepository(BankTransfer).save({
      fingerprint: `race-${Date.now()}-${Math.random()}`, source: BankTransferSource.MOCK,
      accountNumber: 'LAB', amount: 1000, allocatedAmount: 1000, currency: 'PYG',
      movementAt: new Date(), concept: 'Prueba aislada', status: BankTransferStatus.TOMADA,
      rawPayload: {}, firstSeenAt: new Date(), lastSeenAt: new Date(),
    });
    const claim = await dataSource.getRepository(BankTransferClaim).save({
      bankTransferId: transfer.id, receiptNumber: `RACE-${transfer.id}`, amount: 1000,
      referenceType: ClaimReferenceType.TICKET, referenceValue: 'TICKET-1', paymentId: null,
      claimedById: cashier.userId, claimedByRole: cashier.role, claimedAt: new Date(),
      status: ClaimStatus.ACTIVA, printCount: 0, idempotencyKey: transfer.id,
    });
    return { transfer, claim };
  };

  it('evalúa historial bancario real y permite BNF sin alertar por tomas Atlas del mismo monto', async () => {
    const user = await dataSource.getRepository(User).save({
      username: `match-${Date.now()}`, name: 'Operador sintético', password: 'solo-prueba', role: UserRole.ADMIN,
    });
    const paymentRepo = dataSource.getRepository(Payment);
    const bankRepo = dataSource.getRepository(BankTransfer);
    let reference = 0;
    const makePayment = (code: string, isAtlasAccount = true) => paymentRepo.save({
      amount: 200000, allocatedAmount: 0, currency: 'PYG', clientCode: code,
      sourceBank: 'UENO BANK', isAtlasAccount, createdById: user.id,
      paymentRef: `MATCH-${user.id}-${reference++}`, status: PaymentState.PENDIENTE_VERIFICACION,
    });
    const previous = await makePayment('MATCH-7098');
    const history = await bankRepo.save({
      fingerprint: `history-${user.id}`, source: BankTransferSource.MOCK, accountNumber: 'LAB',
      senderAccount: `account-${user.id}`, amount: 200000, allocatedAmount: 200000, currency: 'PYG',
      movementAt: new Date(), concept: 'Historial sintético', status: BankTransferStatus.TOMADA,
      rawPayload: { infoAdicional: { des_swi_ban_remitente: 'UENO BANK SOCIEDAD ANONIMA' } },
      firstSeenAt: new Date(), lastSeenAt: new Date(),
    });
    await dataSource.getRepository(BankTransferClaim).save({
      bankTransferId: history.id, receiptNumber: `H-${user.id}`, amount: 200000,
      referenceType: ClaimReferenceType.CONSULTA, referenceValue: previous.id, paymentId: previous.id,
      claimedById: user.id, claimedByRole: user.role, claimedAt: new Date(),
      status: ClaimStatus.ACTIVA, idempotencyKey: history.id,
    });
    const candidate = await bankRepo.save({
      id: `ffffffff-ffff-4fff-bfff-${user.id.slice(-12)}`,
      fingerprint: `candidate-${user.id}`, source: BankTransferSource.MOCK, accountNumber: 'LAB',
      senderAccount: history.senderAccount, senderBankName: 'UENO BANK', bankDocNumber: `DOC-${user.id}`,
      amount: 200000, allocatedAmount: 0, currency: 'PYG', movementAt: new Date(),
      concept: 'Movimiento sintético', status: BankTransferStatus.DISPONIBLE, rawPayload: {}, firstSeenAt: new Date(), lastSeenAt: new Date(),
    });
    // Más de un lote de distracciones: la identidad exacta no puede quedar fuera por fecha/volumen.
    await bankRepo.insert(Array.from({ length: 501 }, (_, i) => ({
      fingerprint: `noise-${user.id}-${i}`, source: BankTransferSource.MOCK, accountNumber: 'LAB',
      amount: 1000, allocatedAmount: 0, currency: 'PYG', movementAt: new Date(),
      concept: 'Distracción sintética', status: BankTransferStatus.DISPONIBLE, rawPayload: {}, firstSeenAt: new Date(), lastSeenAt: new Date(),
    })));
    const atlas = await makePayment('MATCH-7098');
    atlas.paymentRef = candidate.bankDocNumber!;
    await paymentRepo.save(atlas);
    const matches = await service.matchesForPayment(atlas.id, { ...admin, userId: user.id });
    const match = matches.find((t) => t.id === candidate.id)!.match;
    expect(matches[0].id).toBe(candidate.id);
    expect(match.evidence).toContain('REFERENCIA');
    expect(match.evidence).toContain('CUENTA_CONOCIDA');
    expect(match.strength).toBe('FUERTE');
    await bankRepo.update(candidate.id, { senderBankName: 'ITAU' });
    const changedBank = await service.matchesForPayment(atlas.id, { ...admin, userId: user.id });
    expect(changedBank.find((t) => t.id === candidate.id)!.match.evidence).not.toContain('CUENTA_CONOCIDA');

    atlas.paymentRef = `NEW-${user.id}`;
    await paymentRepo.save(atlas);
    const bnf = await makePayment('MATCH-BNF', false);
    bnf.paymentRef = candidate.bankDocNumber!;
    await paymentRepo.save(bnf);
    await expect(service.matchesForPayment(bnf.id, { ...admin, userId: user.id })).resolves.toEqual([]);
    const payments = new PaymentsService(paymentRepo, dataSource.getRepository(AuditLog));
    const confirmed = await payments.confirmManual(bnf.id, undefined, { ...admin, userId: user.id });
    expect(confirmed.status).toBe(PaymentState.CONFIRMADO_MANUAL);
    expect(Number(confirmed.allocatedAmount)).toBe(0);
    expect((await bankRepo.findOneByOrFail({ id: history.id })).allocatedAmount).toBe(200000);
  });

  it('dos administradores no devuelven dos veces el saldo de la misma toma', async () => {
    const { transfer, claim } = await seed();
    const results = await Promise.allSettled([
      service.void(transfer.id, 'Asignada al ticket equivocado', admin, claim.id),
      service.void(transfer.id, 'Asignada al ticket equivocado', admin, claim.id),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const savedTransfer = await dataSource.getRepository(BankTransfer).findOneByOrFail({ id: transfer.id });
    const savedClaim = await dataSource.getRepository(BankTransferClaim).findOneByOrFail({ id: claim.id });
    const audits = await dataSource.getRepository(AuditLog).find({ where: { bankTransferId: transfer.id, action: 'BANK_TRANSFER_CLAIM_VOIDED' } });
    expect(savedTransfer.allocatedAmount).toBe(0);
    expect(savedClaim.status).toBe(ClaimStatus.ANULADA);
    expect(audits).toHaveLength(1);
  }, 30000);

  it('anulación concurrente con nueva toma conserva saldo igual a la suma de tomas activas', async () => {
    const { transfer, claim } = await seed();
    const results = await Promise.allSettled([
      service.void(transfer.id, 'Asignada al ticket equivocado', admin, claim.id),
      service.claim(transfer.id, {
        referenceType: ClaimReferenceType.TICKET, referenceValue: 'TICKET-2',
        idempotencyKey: '665f8bd4-6eb2-4ef7-a555-b11a0b4bf581', amount: 1000,
      }, cashier),
    ]);
    expect(results[0].status).toBe('fulfilled');
    const savedTransfer = await dataSource.getRepository(BankTransfer).findOneByOrFail({ id: transfer.id });
    const claims = await dataSource.getRepository(BankTransferClaim).find({ where: { bankTransferId: transfer.id } });
    const activeAmount = claims.filter((row) => row.status === ClaimStatus.ACTIVA).reduce((sum, row) => sum + Number(row.amount), 0);
    expect(savedTransfer.allocatedAmount).toBe(activeAmount);
    expect(savedTransfer.allocatedAmount).toBeLessThanOrEqual(Number(savedTransfer.amount));
    expect(claims.find((row) => row.id === claim.id)?.status).toBe(ClaimStatus.ANULADA);
  }, 30000);

  it('dos anulaciones sobre movimientos distintos del mismo pago partido no generan deadlock', async () => {
    const user = await dataSource.getRepository(User).save({
      name: 'Cobrador de laboratorio', username: `void-race-${Date.now()}`,
      role: UserRole.COBRADOR, password: '',
    });
    const payment = await dataSource.getRepository(Payment).save({
      amount: 1000, allocatedAmount: 1000, currency: 'PYG', status: PaymentState.CONFIRMADO,
      isAtlasAccount: true, createdById: user.id,
    });
    const pairs = [] as { transfer: BankTransfer; claim: BankTransferClaim }[];
    for (let index = 0; index < 2; index += 1) {
      const transfer = await dataSource.getRepository(BankTransfer).save({
        fingerprint: `split-${Date.now()}-${index}`, source: BankTransferSource.MOCK,
        accountNumber: 'LAB', amount: 500, allocatedAmount: 500, currency: 'PYG',
        movementAt: new Date(), concept: 'Prueba aislada de pago partido', status: BankTransferStatus.TOMADA,
        rawPayload: {}, firstSeenAt: new Date(), lastSeenAt: new Date(),
      });
      const claim = await dataSource.getRepository(BankTransferClaim).save({
        bankTransferId: transfer.id, receiptNumber: `SPLIT-${transfer.id}`, amount: 500,
        referenceType: ClaimReferenceType.CONSULTA, referenceValue: payment.id, paymentId: payment.id,
        claimedById: user.id, claimedByRole: user.role, claimedAt: new Date(),
        status: ClaimStatus.ACTIVA, printCount: 0, idempotencyKey: transfer.id,
      });
      pairs.push({ transfer, claim });
    }
    const results = await Promise.allSettled(pairs.map(({ transfer, claim }) =>
      service.void(transfer.id, 'Asignada a otra consulta por error', admin, claim.id)));
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    const savedPayment = await dataSource.getRepository(Payment).findOneByOrFail({ id: payment.id });
    const savedClaims = await dataSource.getRepository(BankTransferClaim).find({ where: { paymentId: payment.id } });
    expect(Number(savedPayment.allocatedAmount)).toBe(0);
    expect(savedPayment.status).toBe(PaymentState.PENDIENTE_VERIFICACION);
    expect(savedClaims.map((row) => row.status)).toEqual([ClaimStatus.ANULADA, ClaimStatus.ANULADA]);
  }, 30000);

  it('dos administradores revisando la misma toma dejan una sola auditoria y no la anulan', async () => {
    const { transfer, claim } = await seed();
    const results = await Promise.all([
      service.markReviewed(transfer.id, claim.id, admin),
      service.markReviewed(transfer.id, claim.id, { ...admin, userId: 'admin-2', username: 'admin2' }),
    ]);
    expect(results.every((row) => row.reviewed)).toBe(true);
    const reviews = await dataSource.getRepository(AuditLog).count({ where: { action: 'BANK_CLAIM_REVIEWED', bankTransferId: transfer.id } });
    expect(reviews).toBe(1);
    expect((await dataSource.getRepository(BankTransferClaim).findOneByOrFail({ id: claim.id })).status).toBe(ClaimStatus.ACTIVA);
  }, 30000);

  it('no libera una toma cuando el saldo del movimiento supera el total de claims activos', async () => {
    const { transfer, claim } = await seed();
    claim.amount = 500;
    await dataSource.getRepository(BankTransferClaim).save(claim);
    await expect(service.void(transfer.id, 'Saldo desviado en laboratorio', admin, claim.id))
      .rejects.toMatchObject({ status: 409 });
    const savedClaim = await dataSource.getRepository(BankTransferClaim).findOneByOrFail({ id: claim.id });
    expect(savedClaim.status).toBe(ClaimStatus.ACTIVA);
  }, 30000);
});
