/**
 * Las transferencias se ven por mes, no por día: lo que entró ayer y nadie tomó sigue a la vista.
 * Meses en hora de Paraguay, con la clave "YYYY-MM" que usa el servidor.
 */

const PARAGUAY = 'America/Asuncion';

/** Mes de un instante en Paraguay: "2026-10". */
export const monthKeyOf = (value: string | number | Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: PARAGUAY, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(value))
    .slice(0, 7);

export const currentMonthKey = (now: Date = new Date()): string => monthKeyOf(now);

/** "2026-09" → "septiembre 2026". */
export const monthLabel = (key: string): string => {
  const [year, month] = key.split('-').map(Number);
  if (!year || !month) return key;
  const name = new Intl.DateTimeFormat('es-PY', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 15)));
  return `${name} ${year}`;
};

/** Día y hora corta para listas de un mes: "13/10 17:30". */
export const formatDayTime = (value: string | number | Date): string => {
  const parts = new Intl.DateTimeFormat('es-PY', {
    timeZone: PARAGUAY, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}/${get('month')} ${get('hour')}:${get('minute')}`;
};

/** "Mostrando 26–50 de 120" y cuántas páginas hay. */
export const pageWindow = (page: number, pageSize: number, total: number) => {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const current = Math.min(Math.max(1, page), pages);
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const to = Math.min(total, current * pageSize);
  return { page: current, pages, from, to };
};
