/**
 * Cuenta regresiva del botón "Actualizar" del banco. La espera es una sola para todas las
 * pantallas y la impone el servidor: acá solo se calcula cuánto falta para mostrarlo.
 */

export type RefreshClock = {
  lastPollAt?: string | null;
  refreshCooldownSeconds?: number;
  serverTime?: string;
};

export const DEFAULT_REFRESH_COOLDOWN_SECONDS = 5;

/**
 * Diferencia entre el reloj del servidor y el de esta PC, medida al recibir el estado. Sin esto,
 * una PC con la hora corrida mostraría el botón siempre habilitado o bloqueado de más.
 */
export const serverClockOffsetMs = (serverTime: string | undefined, receivedAtMs: number): number => {
  const server = serverTime ? Date.parse(serverTime) : Number.NaN;
  return Number.isFinite(server) ? server - receivedAtMs : 0;
};

/** El estado tal como lo usa esta pantalla: con la diferencia de reloj medida al recibirlo. */
export const withClockOffset = <T extends { serverTime?: string }>(status: T, receivedAtMs = Date.now()): T & { clockOffsetMs: number } => ({
  ...status,
  clockOffsetMs: serverClockOffsetMs(status.serverTime, receivedAtMs),
});

/**
 * El servidor registró o reversó transferencias desde el último estado que vio esta pantalla.
 * Si un aviso en vivo se perdió, releer la lista lo recupera. La primera vez solo se toma nota.
 */
export const feedChangedSince = (known: number | null | undefined, next: number | null | undefined): boolean =>
  typeof known === 'number' && typeof next === 'number' && known !== next;

/**
 * Leer el contador antes de la lista: en paralelo, una lista vieja junto a un contador nuevo
 * daría por recuperado un movimiento que todavía no se leyó si también se perdió su aviso.
 */
export const readBankFeedSnapshot = async <S, L>(readStatus: () => Promise<S>, readList: () => Promise<L>) => {
  const status = await readStatus();
  const list = await readList();
  return { status, list };
};

/** Milisegundos que faltan para poder volver a consultar al banco (0 si ya se puede). */
export const refreshRemainingMs = (clock: RefreshClock | null | undefined, nowMs: number, offsetMs = 0): number => {
  if (!clock?.lastPollAt) return 0;
  const lastPoll = Date.parse(clock.lastPollAt);
  if (!Number.isFinite(lastPoll)) return 0;
  const cooldownMs = (clock.refreshCooldownSeconds ?? DEFAULT_REFRESH_COOLDOWN_SECONDS) * 1000;
  return Math.max(0, lastPoll + cooldownMs - (nowMs + offsetMs));
};

/** Texto para cuando el servidor no aceptó la actualización. `null`: no hace falta avisar. */
export const refreshRejectionMessage = (reason: string | undefined): string | null => {
  switch (reason) {
    case 'RECIENTE':
      // Otra pantalla acaba de actualizar: lo que traiga llega a todos solo.
      return null;
    case 'EN_CURSO':
      return 'La consulta al banco sigue en curso; la lista se actualizará cuando termine.';
    case 'FUERA_DE_HORARIO':
      return 'Fuera del horario de consulta al banco.';
    case 'DETENIDO':
      return 'La consulta al banco está detenida. Avisá al administrador.';
    case 'REINTENTANDO':
      return 'El banco no respondió hace un momento; se reintenta solo en unos segundos.';
    case 'SIN_PANEL':
      // Solo lo responde un servidor anterior a la versión que consulta igual al apretar el botón.
      return 'Sin conexión en vivo: se recargó la lista, pero no se consultó al banco.';
    default:
      return reason ? 'No se pudo consultar al banco ahora.' : null;
  }
};
