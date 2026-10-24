export type BankFeedMode = 'off' | 'mock' | 'atlas';

export type BankFeedConfig = {
  mode: BankFeedMode;
  account: string;
  intervalSeconds: number;
  /** Horario operativo local "HH:MM-HH:MM"; fuera de el no se consulta al banco ni a la base. */
  hoursFrom: number;
  hoursTo: number;
  /** Desfase horario de Paraguay para los rangos de negocio (fecInicio/fecFin). */
  tzOffset: string;
  tzOffsetMinutes: number;
  maxRows: number;
  overlapMinutes: number;
  sweepMinutes: number;
  /** Cuantos dias hacia atras puede rescatar lo que entro sin nadie mirando (noches, fines de semana). */
  catchUpDays: number;
  /** Completar banco de origen con la Consulta de Operaciones SIPAP (apagado en modo real hasta validarlo). */
  sipapEnrich: boolean;
  /** SWIFT de Atlas para quedarse solo con operaciones recibidas (opcional). */
  ownSwift: string | null;
  /** Error de configuracion: el feed queda apagado pero la API sigue funcionando. */
  configError?: string;
};

const parseOffset = (value: string) => {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`Desfase horario invalido: ${value} (esperado +HH:MM o -HH:MM).`);
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
};

/** Dias de rescate: 4 por defecto, 0 lo apaga, maximo 10 (una ventana mas larga es cara para el banco). */
const parseCatchUpDays = (value: string | undefined) => {
  const days = Number(value?.trim() || 4);
  return Number.isFinite(days) ? Math.min(10, Math.max(0, Math.floor(days))) : 4;
};

const parseHours = (value: string) => {
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`BANK_FEED_HOURS invalido: ${value} (esperado HH:MM-HH:MM).`);
  return { from: Number(match[1]) * 60 + Number(match[2]), to: Number(match[3]) * 60 + Number(match[4]) };
};

/**
 * Configuracion del feed con falla segura: un error (variable mal escrita, modo simulado en
 * produccion) apaga el feed y queda visible en su estado, sin impedir que arranque la API.
 */
export const readBankFeedConfigSafe = (env: (key: string) => string | undefined): BankFeedConfig => {
  try {
    return readBankFeedConfig(env);
  } catch (error: any) {
    return { ...readBankFeedConfig(() => undefined), configError: String(error?.message || error) };
  }
};

export const readBankFeedConfig = (env: (key: string) => string | undefined): BankFeedConfig => {
  const mode = (env('BANK_FEED_MODE') || 'off').trim().toLowerCase() as BankFeedMode;
  if (!['off', 'mock', 'atlas'].includes(mode)) {
    throw new Error(`BANK_FEED_MODE invalido: ${mode} (off | mock | atlas).`);
  }
  if (mode === 'mock' && env('NODE_ENV') === 'production') {
    throw new Error('BANK_FEED_MODE=mock no esta permitido en produccion: generaria transferencias ficticias.');
  }
  const account = (env('BANK_FEED_ACCOUNT') || (mode === 'mock' ? '1870227' : '')).trim();
  if (mode !== 'off' && !/^\d{1,30}$/.test(account)) {
    throw new Error('BANK_FEED_ACCOUNT debe ser el numero de cuenta (solo digitos).');
  }
  const tzOffset = (env('ATLAS_TIMESTAMP_OFFSET') || '-03:00').trim();
  const hours = parseHours(env('BANK_FEED_HOURS') || '07:00-20:00');
  return {
    mode,
    account,
    intervalSeconds: Math.max(5, Number(env('BANK_FEED_INTERVAL_SECONDS')) || 5),
    hoursFrom: hours.from,
    hoursTo: hours.to,
    tzOffset,
    tzOffsetMinutes: parseOffset(tzOffset),
    maxRows: Math.min(500, Math.max(10, Number(env('BANK_FEED_MAX_ROWS')) || 200)),
    overlapMinutes: Math.max(1, Number(env('BANK_FEED_OVERLAP_MINUTES')) || 15),
    sweepMinutes: Math.max(1, Number(env('BANK_FEED_SWEEP_MINUTES')) || 5),
    catchUpDays: parseCatchUpDays(env('BANK_FEED_CATCHUP_DAYS')),
    sipapEnrich: (env('BANK_FEED_SIPAP_ENRICH') ?? (mode === 'mock' ? 'true' : 'false')) === 'true',
    ownSwift: env('BANK_FEED_OWN_SWIFT')?.trim() || null,
  };
};

/** Minutos desde la medianoche local para `date` segun el desfase configurado. */
export const localMinutesOfDay = (date: Date, offsetMinutes: number) => {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
};

/** Inicio del dia local (00:00 en el desfase dado) expresado como instante UTC. */
export const startOfLocalDay = (date: Date, offsetMinutes: number) => {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - offsetMinutes * 60_000);
};

/** Fecha local YYYY-MM-DD. */
export const localDateKey = (date: Date, offsetMinutes: number) =>
  new Date(date.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10);

/** Instante con el desfase de negocio, sin milisegundos: 2026-09-19T08:15:00-03:00 (formato de fecInicio/fecFin). */
export const formatWithOffset = (date: Date, offset: string, offsetMinutes: number) =>
  new Date(date.getTime() + offsetMinutes * 60_000).toISOString().replace(/\.\d{3}Z$/, offset);

export const isWithinHours = (config: BankFeedConfig, now: Date) => {
  const minutes = localMinutesOfDay(now, config.tzOffsetMinutes);
  return minutes >= config.hoursFrom && minutes < config.hoursTo;
};
