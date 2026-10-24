import { randomInt } from 'crypto';
import { AtlasBalance } from './atlas/atlas-balance';
import { AtlasClient } from './atlas/atlas-client';
import { AtlasMovement, parseMovementsResponse } from './atlas/atlas-movements';
import { BankEntity, parseSipapOperationsResponse, SipapOperation } from './atlas/atlas-sipap';
import { BankFeedConfig, formatWithOffset, startOfLocalDay } from './bank-feed.config';

export type FeedWindow = { from: Date; to: Date; includeReversed: boolean };
export type FeedFetchResult = { movements: AtlasMovement[]; verified: boolean; truncated: boolean };
export type BalanceResult = { balance: AtlasBalance; verified: boolean; simulated: boolean };

export interface BankFeedSource {
  fetch(window: FeedWindow): Promise<FeedFetchResult>;
  /** Operaciones SIPAP del periodo (para el banco de origen). */
  fetchSipapOperations(from: Date, to: Date): Promise<SipapOperation[]>;
  fetchBankEntities(): Promise<BankEntity[]>;
  /** Saldo de la cuenta: solo a pedido del admin, nunca dentro del sondeo. */
  fetchBalance(): Promise<BalanceResult>;
}

/** Fuente real: movimientos detallados (solo creditos) del banco. */
export class AtlasFeedSource implements BankFeedSource {
  constructor(
    private readonly client: AtlasClient,
    private readonly config: BankFeedConfig,
  ) {}

  async fetch(window: FeedWindow): Promise<FeedFetchResult> {
    // Atlas filtra por fecha de proceso: el sábado 17/10/2026 los créditos del día
    // solo aparecieron al incluir el lunes 19/10. Margen acotado para fines de semana
    // y feriados; la fecha REAL del movimiento sigue limitada a la ventana pedida.
    const processUntil = new Date(window.to.getTime() + 7 * 24 * 60 * 60 * 1000);
    const { movements, verified } = await this.client.consultarMovimientosDetallados({
      numeroCuenta: this.config.account,
      fecInicio: formatWithOffset(window.from, this.config.tzOffset, this.config.tzOffsetMinutes),
      fecFin: formatWithOffset(processUntil, this.config.tzOffset, this.config.tzOffsetMinutes),
      // Sin `tipoMovimiento`: el manual documenta "C", pero el sandbox responde 500 con "C" y solo
      // acepta "CREDITO" (verificado el 2026-09-21). Los creditos se filtran aca con `isCredit`, asi
      // el feed funciona con cualquiera de las dos interpretaciones del banco.
      cantidad: this.config.maxRows,
      incluyeReversa: window.includeReversed,
      orden: 'DESC',
    });
    // El límite corresponde a la respuesta cruda, antes de filtrar: no ocultar truncamiento.
    return {
      movements: movements.filter((movement) => {
        const at = new Date(movement.fechaMovimiento).getTime();
        return at >= window.from.getTime() && at <= window.to.getTime();
      }),
      verified,
      truncated: movements.length >= this.config.maxRows,
    };
  }

  fetchSipapOperations(from: Date, to: Date) {
    return this.client.consultarOperacionesSipap({
      fechaDesde: formatWithOffset(from, this.config.tzOffset, this.config.tzOffsetMinutes),
      fechaHasta: formatWithOffset(to, this.config.tzOffset, this.config.tzOffsetMinutes),
      codSwiBeneficiario: this.config.ownSwift ?? undefined,
    });
  }

  fetchBankEntities() {
    return this.client.consultarEntidadesParticipantes();
  }

  async fetchBalance(): Promise<BalanceResult> {
    const { balance, verified } = await this.client.consultarSaldo(this.config.account);
    return { balance, verified, simulated: false };
  }
}

const MOCK_SENDERS = [
  ['MARIA ELENA BENITEZ', '3456789', '110234'],
  ['COMERCIAL NANDUTI S.A.', '80012345-6', '220981'],
  ['JUAN CARLOS ORTIZ', '4123987', '334120'],
  ['FERRETERIA CENTRAL SRL', '80098765-1', '118877'],
  ['CARMEN DUARTE', '2987456', '540012'],
  ['DISTRIBUIDORA SUR', '80055512-3', '661209'],
  ['PEDRO GONZALEZ', '5012348', '771234'],
  ['KIOSKO LA ESQUINA', '6345120', '882345'],
] as const;
const MOCK_BANKS = ['TRANSFERENCIA SIPAP', 'TRANSFERENCIA SPI', 'TRANSFERENCIAS ENTRE CUENTAS'];
// Codigos reales del catalogo del sandbox (entidades participantes); los nombres son los del banco.
const MOCK_ENTITIES: BankEntity[] = [
  { codigo: 'COMAPYPA', descripcion: 'UENO BANK SOCIEDAD ANONIMA', descripcionCorta: 'UENO' },
  { codigo: 'BNFAPYPA', descripcion: 'BANCO NACIONAL DE FOMENTO', descripcionCorta: 'BNF' },
  { codigo: 'AMAMPYPA', descripcion: 'BANCO BASA SA', descripcionCorta: 'BASA' },
  { codigo: 'BCNAPYPA', descripcion: 'BANCO CONTINENTAL SAECA', descripcionCorta: 'CONTINENTAL' },
];
const MOCK_REASONS = ['Pago a Proveedores', 'Ayuda Familiar', 'Pago de servicios'];

/**
 * Fuente simulada para desarrollo y demostraciones. Produce el mismo JSON que el banco, asi el
 * resto del flujo (validacion, huella, registro) es identico al real. Prohibida en produccion.
 */
export class MockFeedSource implements BankFeedSource {
  private readonly movements: Record<string, unknown>[] = [];
  private readonly operations: Record<string, unknown>[] = [];
  private nextDoc = 500000 + randomInt(0, 100000);
  private lastGeneratedAt = 0;
  private seededDay: string | null = null;

  constructor(
    private readonly config: BankFeedConfig,
    private readonly averageSecondsBetweenCredits = 35,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private makeMovement(at: Date) {
    const [name, doc, account] = MOCK_SENDERS[randomInt(0, MOCK_SENDERS.length)];
    const amount = randomInt(2, 60) * 25000;
    this.nextDoc += randomInt(1, 40);
    const ticket = randomInt(0, 3) === 0 ? `ticket ${randomInt(1000, 9999)}` : randomInt(0, 2) === 0 ? 'pago cuota' : null;
    // Banco que envia: el real lo manda en infoAdicional de cada credito SIPAP.
    const entity = MOCK_ENTITIES[randomInt(0, MOCK_ENTITIES.length)];
    const sipapReference = `${entity.codigo}ARES${String(2609000000000 + this.nextDoc).padStart(21, '0')}`;
    // Operacion SIPAP que acompana al credito (algunas quedan sin operacion, como pasaria con
    // transferencias entre cuentas del mismo banco).
    if (randomInt(0, 5) !== 0) {
      this.operations.push({
        nroReferencia: 2609000000000 + this.nextDoc,
        nroOperacion: 2609000000000 + this.nextDoc,
        tipTransferencia: randomInt(0, 6) === 0 ? 'LBTR' : 'SPI',
        monto: amount,
        fecha: formatWithOffset(at, this.config.tzOffset, this.config.tzOffsetMinutes),
        concepto: ticket ?? 'pago',
        motivo: MOCK_REASONS[randomInt(0, MOCK_REASONS.length)],
        situacion: 'L',
        estado: 'A',
        codSwiPteSolicitante: entity.codigo,
        nroCtaSolicitante: account,
        nroDocSolicitante: doc,
        nomSolicitante: name,
        codSwiPteBeneficiario: 'SIMULADO',
        nroCtaBeneficiario: this.config.account,
      });
    }
    return {
      monto: amount,
      numeroCuenta: this.config.account,
      moneda: { nombre: 'Guaranies', codigo: 6900, iso: 'PYG', simbolo: 'Gs', abreviatura: 'GS' },
      concepto: MOCK_BANKS[randomInt(0, MOCK_BANKS.length)],
      tipoMovimiento: 'CREDITO',
      fechaMovimiento: formatWithOffset(at, this.config.tzOffset, this.config.tzOffsetMinutes),
      nroDocumento: this.nextDoc,
      nroTransaccionBancard: 0,
      infoAdicional: {
        estado: 'N',
        reversado: 'N',
        cod_usu_reversion: null,
        // Como texto, igual que el banco real desde el 2026-10-07 (el manual dice Integer).
        cod_tra_padre: '388.0',
        des_tra_padre: 'TRANSFERENCIAS ENTRE CUENTAS',
        cod_transaccion: '602.0',
        des_transaccion: 'CREDITO EN CUENTA',
        nro_doc_remitente: doc,
        nom_remitente: name,
        nro_cta_remitente: account,
        concepto: ticket,
        cod_swi_ban_remitente: entity.codigo,
        des_swi_ban_remitente: entity.descripcion,
        nro_ref_externa: sipapReference,
      },
      'fecha Proceso': formatWithOffset(at, this.config.tzOffset, this.config.tzOffsetMinutes).slice(0, 10),
    };
  }

  private generate() {
    const now = this.now();
    const dayKey = startOfLocalDay(now, this.config.tzOffsetMinutes).toISOString();
    if (this.seededDay !== dayKey) {
      // Algunas transferencias anteriores del dia para que el panel no arranque vacio.
      this.seededDay = dayKey;
      for (let i = 8; i >= 1; i--) this.movements.push(this.makeMovement(new Date(now.getTime() - i * 7 * 60_000)));
      this.lastGeneratedAt = now.getTime();
      return;
    }
    const elapsedSeconds = (now.getTime() - this.lastGeneratedAt) / 1000;
    if (elapsedSeconds >= this.averageSecondsBetweenCredits * (0.5 + Math.random())) {
      this.movements.push(this.makeMovement(now));
      this.lastGeneratedAt = now.getTime();
    }
  }

  async fetch(window: FeedWindow): Promise<FeedFetchResult> {
    this.generate();
    const inWindow = this.movements.filter((m) => {
      const at = new Date(String(m.fechaMovimiento)).getTime();
      return at >= window.from.getTime() && at <= window.to.getTime();
    });
    return { movements: parseMovementsResponse({ listaMovimiento: inWindow }, this.config.account), verified: false, truncated: false };
  }

  async fetchSipapOperations(from: Date, to: Date) {
    const inRange = this.operations.filter((op) => {
      const at = new Date(String(op.fecha)).getTime();
      return at >= from.getTime() && at <= to.getTime();
    });
    return parseSipapOperationsResponse({ operacionesSipap: inRange });
  }

  async fetchBankEntities() {
    return MOCK_ENTITIES;
  }

  /** Saldo inventado y marcado como simulado: solo para ver la pantalla del admin en desarrollo. */
  async fetchBalance(): Promise<BalanceResult> {
    const credits = this.movements.reduce((sum, m) => sum + Number(m.monto), 0);
    const saldo = 25_000_000 + credits;
    return {
      simulated: true,
      verified: false,
      balance: {
        nroCuenta: this.config.account,
        producto: { codigo: 1, descripcion: 'CUENTA SIMULADA', descripcionCorta: 'SIMULADA' },
        moneda: 'PYG',
        saldo,
        saldoDisponible: saldo,
        depositoConfirmar: null,
        saldoBloqueado: null,
        saldoProtegido: null,
        saldoPromedio: null,
      },
    };
  }
}
