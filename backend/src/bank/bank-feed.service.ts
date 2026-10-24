import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PaymentsGateway } from '../payments/payments.gateway';
import { ROOMS } from '../payments/realtime-rooms';
import { AtlasApiError } from './atlas/atlas-client';
import { isCredit } from './atlas/atlas-movements';
import { matchSipapOperation, normalizeIdentifier } from './atlas/atlas-sipap';
import { toNormalizedCredit } from './bank-credit';
import { isWithinHours, localDateKey, startOfLocalDay } from './bank-feed.config';
import type { BankFeedConfig } from './bank-feed.config';
import type { BalanceResult, BankFeedSource, FeedWindow } from './bank-feed.sources';
import { BANK_FEED_CONFIG, BANK_FEED_SOURCE } from './bank.constants';
import { BankTransfersService } from './bank-transfers.service';
import { BankTransfer, BankTransferSource } from './entities/bank-transfer.entity';

export type BankFeedState = 'APAGADO' | 'EN_ESPERA' | 'FUERA_DE_HORARIO' | 'EN_VIVO' | 'ERROR' | 'DETENIDO' | 'SIN_CONFIGURAR';

export type BankFeedStatus = {
  mode: string;
  state: BankFeedState;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  /** true solo si la respuesta del banco vino firmada y verificada. */
  verified: boolean;
  intervalSeconds: number;
  hours: string;
  /** Inicio de la ultima consulta al banco, automatica o pedida. */
  lastPollAt: string | null;
  /** Quien pidio la ultima actualizacion manual; null si la ultima fue automatica. */
  lastRefreshBy: string | null;
  /** Espera compartida entre dos consultas al banco: vale para todas las pantallas. */
  refreshCooldownSeconds: number;
  /**
   * Transferencias que el feed registro o reverso desde que arranco el servidor. Una pantalla que
   * ve cambiar este numero relee la lista: asi recupera un aviso en vivo que se haya perdido.
   */
  changeCount: number;
};

/** Lo que recibe cada pantalla: el estado mas la hora del servidor, para que la cuenta regresiva
 * no dependa del reloj de cada PC. */
export type BankFeedStatusView = BankFeedStatus & { serverTime: string };

export type RefreshRejection = 'RECIENTE' | 'EN_CURSO' | 'FUERA_DE_HORARIO' | 'DETENIDO' | 'REINTENTANDO';

export type RefreshResult = { accepted: boolean; reason?: RefreshRejection; status: BankFeedStatusView };

const MAX_BACKOFF_MS = 5 * 60 * 1000;
const MIN_SPLIT_MS = 60 * 1000;
// La Consulta de Operaciones SIPAP puede tardar mas de 20 s: corre aparte y con menos frecuencia.
const ENRICH_EVERY_MS = 30 * 1000;
const ENRICH_MAX_AGE_MS = 2 * 60 * 60 * 1000;
// El saldo es una consulta puntual del admin: varios clics seguidos no deben repetirla.
const BALANCE_CACHE_MS = 15 * 1000;
// Minimo entre dos consultas al banco, sumando las automaticas, las del primer panel que se abre y
// las del boton "Actualizar". Es una sola espera para todos: con 9 pantallas abiertas, el banco
// recibe como mucho una consulta cada 5 s, y lo que trae le llega a todos por el tiempo real.
export const REFRESH_COOLDOWN_MS = 5 * 1000;
// "Actualizar" responde cuando termina la consulta, pero no deja colgada la pantalla si el banco tarda.
const REFRESH_WAIT_MAX_MS = 20 * 1000;
// Una consulta mas lenta que esto queda en el log: ayuda a separar demoras del banco de pausas del sondeo.
const SLOW_POLL_MS = 10 * 1000;

export type BankBalanceView = BalanceResult & { consultedAt: string };

export class BankFeedUnavailableError extends Error {}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * Sondea al banco y registra los creditos entrantes. Para cuidar el consumo de Neon y del banco
 * solo consulta si: el modo no es "off", se esta dentro del horario operativo y hay al menos un
 * panel de transferencias abierto y visible (sala de demanda, no cualquier socket conectado). La deduplicacion usa una cache de huellas del dia; la base solo se escribe
 * cuando aparece un movimiento nuevo o una reversa.
 */
@Injectable()
export class BankFeedService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BankFeedService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private dayKey: string | null = null;
  private seen = new Map<string, { id: string; reversed: boolean }>();
  private lastMovementAt: Date | null = null;
  private lastSweepAt = 0;
  private consecutiveErrors = 0;
  private backoffUntil = 0;
  private stopped = false;
  private status: BankFeedStatus;
  // Transferencias del dia sin banco de origen (id -> hora del movimiento); evita consultar la base de mas.
  private pendingBank = new Map<string, number>();
  private enriching = false;
  private lastEnrichAt = 0;
  private entities = new Map<string, string>();
  private entitiesDay: string | null = null;
  private lastPollAt = 0;
  private inFlight: Promise<void> | null = null;
  private changeCount = 0;
  /** Ultimo estado de demanda informado en el log (null: todavia ninguno). */
  private watching: boolean | null = null;
  /**
   * Inicio del rescate pendiente: lo que entro mientras nadie miraba (despues del horario, de noche,
   * un fin de semana). Se calcula al cambiar de dia y se consume en el primer sondeo que funcione.
   */
  private catchUpFrom: Date | null = null;
  private stopListeningDemand: (() => void) | null = null;
  private balanceCache: { at: number; value: BankBalanceView } | null = null;
  private balancePending: Promise<BankBalanceView> | null = null;

  constructor(
    @Inject(BANK_FEED_CONFIG) private readonly config: BankFeedConfig,
    @Optional() @Inject(BANK_FEED_SOURCE) private readonly source: BankFeedSource | null,
    private readonly transfers: BankTransfersService,
    private readonly gateway: PaymentsGateway,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    const misconfigured = !!config.configError || (config.mode !== 'off' && !source);
    this.status = {
      mode: config.mode,
      state: misconfigured ? 'SIN_CONFIGURAR' : config.mode === 'off' ? 'APAGADO' : 'EN_ESPERA',
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: config.configError ?? (misconfigured ? 'Configuración ATLAS_* incompleta o inválida: revisar el log del backend.' : null),
      verified: false,
      intervalSeconds: config.intervalSeconds,
      hours: `${hhmm(config.hoursFrom)}-${hhmm(config.hoursTo)}`,
      lastPollAt: null,
      lastRefreshBy: null,
      refreshCooldownSeconds: REFRESH_COOLDOWN_MS / 1000,
      changeCount: 0,
    };
  }

  /** Ya paso la espera compartida desde la ultima consulta al banco. */
  private cooledDown(nowMs = Date.now()) {
    return nowMs - this.lastPollAt >= REFRESH_COOLDOWN_MS;
  }

  onModuleInit() {
    if (this.config.mode === 'off' || !this.source) return;
    this.logger.log(`Feed bancario en modo ${this.config.mode}, cuenta ***${this.config.account.slice(-3)}, cada ${this.config.intervalSeconds}s.`);
    // El ciclo automatico tambien respeta la espera: si alguien acaba de actualizar, se saltea.
    this.timer = setInterval(() => {
      if (this.cooledDown()) void this.tick();
    }, this.config.intervalSeconds * 1000);
    this.stopListeningDemand = this.gateway.onBankDemand(() => {
      if (this.cooledDown()) void this.tick();
    });
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.stopListeningDemand?.();
  }

  /**
   * Saldo de la cuenta para el admin, a pedido. No pasa por las salas en vivo ni por el sondeo.
   * Con el feed detenido por credenciales no se consulta: insistir puede bloquear la API key.
   */
  async getBalance(): Promise<BankBalanceView> {
    if (this.config.mode === 'off' || !this.source) throw new BankFeedUnavailableError('La conexión con el banco está apagada o sin configurar.');
    if (this.stopped) throw new BankFeedUnavailableError('La consulta al banco está detenida por un error de credenciales.');
    if (this.balanceCache && Date.now() - this.balanceCache.at < BALANCE_CACHE_MS) return this.balanceCache.value;
    if (!this.balancePending) {
      this.balancePending = this.source
        .fetchBalance()
        .then((result) => {
          const value = { ...result, consultedAt: new Date().toISOString() };
          this.balanceCache = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          this.balancePending = null;
        });
    }
    return this.balancePending;
  }

  getStatus(): BankFeedStatusView {
    return { ...this.status, serverTime: new Date().toISOString() };
  }

  /**
   * Boton "Actualizar" de cualquier pantalla: consulta al banco ahora y responde cuando termino, para
   * que la pantalla relea la lista con lo que trajo sin depender solo del aviso en vivo. Quien aprieta
   * el boton esta mirando: no hace falta que su panel figure en la sala de demanda (un navegador puede
   * informar "oculto" a una ventana tapada aunque la persona la este usando).
   * La espera la impone el servidor y es una sola para todos: si alguien consulto hace menos de 5 s,
   * lo que trajo ya esta guardado; si hay una consulta en curso, se espera a que termine.
   */
  async requestRefresh(requestedBy: string, now = new Date()): Promise<RefreshResult> {
    if (this.config.mode === 'off' || !this.source) throw new BankFeedUnavailableError('La conexión con el banco está apagada o sin configurar.');
    const reject = (reason: RefreshRejection): RefreshResult => ({ accepted: false, reason, status: this.getStatus() });
    if (this.stopped) return reject('DETENIDO');
    if (!isWithinHours(this.config, now)) return reject('FUERA_DE_HORARIO');
    if (this.inFlight) {
      const completed = await this.waitAtMost(this.inFlight, REFRESH_WAIT_MAX_MS);
      return completed ? { accepted: true, status: this.getStatus() } : reject('EN_CURSO');
    }
    if (!this.cooledDown(now.getTime())) return reject('RECIENTE');
    if (now.getTime() < this.backoffUntil) return reject('REINTENTANDO');
    const completed = await this.waitAtMost(this.tick(now, requestedBy, true), REFRESH_WAIT_MAX_MS);
    return completed ? { accepted: true, status: this.getStatus() } : reject('EN_CURSO');
  }

  private async waitAtMost(work: Promise<unknown>, ms: number) {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work.then(() => true),
        new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms))),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Reanuda el feed despues de un error de credenciales (accion del admin). */
  resume(): BankFeedStatusView {
    this.stopped = false;
    this.consecutiveErrors = 0;
    this.backoffUntil = 0;
    this.setStatus({ state: 'EN_ESPERA', lastError: null });
    return this.getStatus();
  }

  private setStatus(patch: Partial<BankFeedStatus>) {
    const next = { ...this.status, ...patch };
    const changed = JSON.stringify(next) !== JSON.stringify(this.status);
    this.status = next;
    if (changed) {
      const view = this.getStatus();
      this.gateway.emitToRoom(ROOMS.bankFull, 'bank-feed:status', view);
      this.gateway.emitToRoom(ROOMS.bankMasked, 'bank-feed:status', view);
    }
  }

  /** Paneles de transferencias abiertos y visibles (no cualquier pantalla conectada). */
  private subscribers() {
    return this.gateway.countInRoom(ROOMS.bankDemand);
  }

  /** Deja en el log cuando el sondeo se pausa o se reanuda por los paneles visibles. */
  private noteDemand(watchers: number) {
    const watching = watchers > 0;
    if (this.watching === watching) return;
    if (this.watching !== null || watching) {
      this.logger.log(watching
        ? `Panel visible (${watchers}): se consulta al banco cada ${this.config.intervalSeconds}s.`
        : 'Ningún panel visible: se pausa la consulta automática al banco.');
    }
    this.watching = watching;
  }

  /** Carga una vez por dia las huellas ya registradas para no reescribirlas. */
  private async ensureDayCache(now: Date) {
    const key = localDateKey(now, this.config.tzOffsetMinutes);
    if (this.dayKey === key) return;
    const dayStart = startOfLocalDay(now, this.config.tzOffsetMinutes);
    const repo = this.dataSource.getRepository(BankTransfer);
    const source = this.config.mode === 'mock' ? BankTransferSource.MOCK : BankTransferSource.ATLAS;

    // Rescate: desde el ultimo movimiento ya registrado antes de hoy, con margen, y como mucho
    // `catchUpDays` atras. Sin historial (primer arranque) no se importa nada anterior a hoy: eso
    // ya se cobro con el sistema viejo y entraria como disponible para tomarse otra vez.
    const previous = await repo
      .createQueryBuilder('t')
      .select('MAX(t.movementAt)', 'max')
      .where('t.accountNumber = :account AND t.source = :source AND t.movementAt < :before', {
        account: this.config.account,
        source,
        before: dayStart,
      })
      .getRawOne();
    const lastStored = previous?.max ? new Date(previous.max) : null;
    const limit = new Date(now.getTime() - this.config.catchUpDays * 24 * 60 * 60 * 1000);
    const fromLast = lastStored ? new Date(lastStored.getTime() - this.config.overlapMinutes * 60_000) : null;
    this.catchUpFrom = fromLast && this.config.catchUpDays > 0 ? (fromLast > limit ? fromLast : limit) : null;
    if (this.catchUpFrom && this.catchUpFrom >= dayStart) this.catchUpFrom = null;

    const rows = await repo
      .createQueryBuilder('t')
      .select(['t.id', 't.fingerprint', 't.reversedAt', 't.movementAt', 't.senderBankCode'])
      .where('t.accountNumber = :account AND t.movementAt >= :from', { account: this.config.account, from: this.catchUpFrom ?? dayStart })
      .getMany();
    this.seen = new Map(rows.map((r) => [r.fingerprint, { id: r.id, reversed: !!r.reversedAt }]));
    this.pendingBank = new Map(rows.filter((r) => !r.senderBankCode && !r.reversedAt).map((r) => [r.id, r.movementAt.getTime()]));
    this.lastMovementAt = rows.reduce<Date | null>((max, r) => (!max || r.movementAt > max ? r.movementAt : max), null);
    this.dayKey = key;
    this.lastSweepAt = 0;
  }

  /** Consulta una ventana; si el banco devuelve el maximo de filas, la parte en dos. */
  private async fetchWindow(window: FeedWindow, depth = 0) {
    const result = await this.source!.fetch(window);
    const span = window.to.getTime() - window.from.getTime();
    if (!result.truncated || depth >= 6 || span <= MIN_SPLIT_MS) {
      if (result.truncated) this.logger.warn('Ventana del banco truncada aun despues de partirla; puede faltar algun movimiento.');
      return result;
    }
    const middle = new Date(window.from.getTime() + Math.floor(span / 2));
    const older = await this.fetchWindow({ ...window, to: middle }, depth + 1);
    const newer = await this.fetchWindow({ ...window, from: middle }, depth + 1);
    return {
      movements: [...older.movements, ...newer.movements],
      verified: older.verified && newer.verified,
      truncated: older.truncated || newer.truncated,
    };
  }

  /**
   * Completa el banco de origen de las transferencias recientes con la Consulta de Operaciones SIPAP.
   * Solo asigna vinculos unicos (monto + cuenta del remitente); nunca cambia estado ni tomas.
   */
  async enrichSenderBanks(now = new Date()) {
    if (this.enriching || !this.source) return;
    this.enriching = true;
    try {
      for (const [id, at] of this.pendingBank) {
        if (now.getTime() - at > ENRICH_MAX_AGE_MS) this.pendingBank.delete(id);
      }
      const pending = await this.transfers.pendingSenderBank([...this.pendingBank.keys()]);
      const pendingIds = new Set(pending.map((t) => t.id));
      for (const id of this.pendingBank.keys()) if (!pendingIds.has(id)) this.pendingBank.delete(id);
      if (pending.length === 0) return;

      const dayKey = localDateKey(now, this.config.tzOffsetMinutes);
      if (this.entitiesDay !== dayKey) {
        const entities = await this.source.fetchBankEntities();
        this.entities = new Map(entities.map((e) => [e.codigo, e.descripcionCorta || e.descripcion]));
        this.entitiesDay = dayKey;
      }

      const earliest = new Date(Math.min(...pending.map((t) => t.movementAt.getTime())));
      const from = startOfLocalDay(earliest, this.config.tzOffsetMinutes);
      const account = normalizeIdentifier(this.config.account);
      const operations = (await this.source.fetchSipapOperations(from, now)).filter(
        (op) =>
          (!this.config.ownSwift || op.codSwiPteBeneficiario === this.config.ownSwift) &&
          (!op.nroCtaBeneficiario || normalizeIdentifier(op.nroCtaBeneficiario) === account),
      );
      const used = await this.transfers.usedSipapReferences(from);

      for (const transfer of pending) {
        const op = matchSipapOperation(
          { amount: Number(transfer.amount), senderAccount: transfer.senderAccount, senderDoc: transfer.senderDoc, movementAt: transfer.movementAt },
          operations,
          used,
        );
        if (!op) continue;
        if (op.nroReferencia) used.add(op.nroReferencia);
        const code = op.codSwiPteSolicitante;
        await this.transfers.applySenderBank(transfer.id, {
          senderBankCode: code,
          senderBankName: code ? this.entities.get(code) ?? code : null,
          channel: op.tipTransferencia,
          sipapReference: op.nroReferencia,
          sipapReason: op.motivo,
        });
        this.pendingBank.delete(transfer.id);
      }
    } finally {
      this.enriching = false;
    }
  }

  /**
   * Una consulta al banco. La automatica necesita un panel visible; la del boton (`manual`) no,
   * porque quien lo aprieta esta mirando.
   */
  async tick(now = new Date(), requestedBy?: string, manual = false): Promise<void> {
    if (this.config.mode === 'off' || !this.source || this.stopped || this.running) return;
    if (!isWithinHours(this.config, now)) return this.setStatus({ state: 'FUERA_DE_HORARIO' });
    const watchers = this.subscribers();
    this.noteDemand(watchers);
    if (watchers === 0 && !manual) return this.setStatus({ state: 'EN_ESPERA' });
    if (now.getTime() < this.backoffUntil) return;

    this.running = true;
    this.lastPollAt = now.getTime();
    // Arranca la espera compartida en todas las pantallas, y se ve quien pidio la consulta.
    this.setStatus({ lastPollAt: now.toISOString(), lastRefreshBy: requestedBy ?? null });
    const run = this.poll(now, watchers, manual);
    this.inFlight = run;
    try {
      await run;
    } finally {
      this.inFlight = null;
      this.running = false;
    }
  }

  private async poll(now: Date, watchers: number, manual: boolean) {
    const startedAt = Date.now();
    let added = 0;
    try {
      await this.ensureDayCache(now);
      const dayStart = startOfLocalDay(now, this.config.tzOffsetMinutes);
      const sweep = now.getTime() - this.lastSweepAt >= this.config.sweepMinutes * 60_000;
      // Solapamiento: el banco puede registrar un movimiento con hora anterior a la del ultimo visto.
      const overlapFrom = this.lastMovementAt
        ? new Date(this.lastMovementAt.getTime() - this.config.overlapMinutes * 60_000)
        : dayStart;
      const from = this.catchUpFrom ?? (sweep || overlapFrom < dayStart ? dayStart : overlapFrom);

      const result = await this.fetchWindow({ from, to: now, includeReversed: true });
      if (sweep) this.lastSweepAt = now.getTime();
      if (this.catchUpFrom) {
        this.logger.log(`Rescate de lo que entro sin nadie mirando desde ${this.catchUpFrom.toISOString()}.`);
        this.catchUpFrom = null;
      }

      const sourceTag = this.config.mode === 'mock' ? BankTransferSource.MOCK : BankTransferSource.ATLAS;
      for (const movement of result.movements) {
        if (!isCredit(movement)) continue;
        const credit = toNormalizedCredit(movement, sourceTag);
        if (!this.lastMovementAt || credit.movementAt > this.lastMovementAt) this.lastMovementAt = credit.movementAt;

        const cached = this.seen.get(credit.fingerprint);
        if (cached && (cached.reversed || !credit.reversed)) continue;

        const { transfer, created, reversedNow } = await this.transfers.registerCredit(credit);
        this.seen.set(credit.fingerprint, { id: transfer.id, reversed: !!transfer.reversedAt });
        if (created) {
          added += 1;
          this.changeCount += 1;
          await this.transfers.broadcast(transfer, 'bank-transfers:new');
          if (!transfer.reversedAt) this.pendingBank.set(transfer.id, transfer.movementAt.getTime());
        } else if (reversedNow) {
          this.changeCount += 1;
          await this.transfers.broadcast(transfer, 'bank-transfers:updated');
        }
      }

      this.consecutiveErrors = 0;
      this.setStatus({
        state: 'EN_VIVO',
        lastSuccessAt: now.toISOString(),
        lastError: null,
        verified: result.verified,
        changeCount: this.changeCount,
      });
      const elapsed = Date.now() - startedAt;
      // Sin importes ni remitentes: solo cuantas, cuanto tardo y quien estaba mirando.
      if (added > 0) {
        this.logger.log(`Consulta al banco: ${added} transferencia(s) nueva(s) en ${elapsed} ms (${manual ? 'botón Actualizar' : 'automática'}, paneles visibles: ${watchers}).`);
      }
      if (elapsed > SLOW_POLL_MS) this.logger.warn(`Consulta al banco lenta: ${elapsed} ms.`);

      if (this.config.sipapEnrich && this.pendingBank.size > 0 && now.getTime() - this.lastEnrichAt >= ENRICH_EVERY_MS) {
        this.lastEnrichAt = now.getTime();
        // No se espera: una consulta SIPAP lenta no debe demorar la aparicion de transferencias nuevas.
        void this.enrichSenderBanks(now).catch((error) =>
          this.logger.warn('No se pudo completar el banco de origen: ' + String(error?.message || error).slice(0, 200)),
        );
      }
    } catch (error: any) {
      const message = String(error?.message || error).slice(0, 300);
      const lastErrorAt = now.toISOString();
      if (error instanceof AtlasApiError && error.isAuthError) {
        // Credenciales o permisos invalidos: insistir no sirve y puede bloquear la API key.
        this.stopped = true;
        this.logger.error(`Feed bancario detenido por error de autenticacion: ${message}`);
        this.setStatus({ state: 'DETENIDO', lastError: message, lastErrorAt });
      } else {
        this.consecutiveErrors += 1;
        const wait = Math.min(MAX_BACKOFF_MS, this.config.intervalSeconds * 1000 * 2 ** this.consecutiveErrors);
        this.backoffUntil = now.getTime() + wait;
        this.logger.warn(`Fallo el sondeo del banco (${this.consecutiveErrors}); reintento en ${Math.round(wait / 1000)}s: ${message}`);
        this.setStatus({ state: 'ERROR', lastError: message, lastErrorAt });
      }
    }
  }
}
