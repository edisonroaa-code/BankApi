import React from 'react';
import { BankClaim, BankFeedStatus, BankTransfer, BankTransferStatus, MatchAssessment, MatchStrength } from '../../types';
import { parseDbTimestamp } from '../../services/date';

export const toDate = (value: string) => parseDbTimestamp(value) ?? new Date(value);

// Los montos de las consultas llegan como texto (numeric de Postgres): hay que convertirlos
// antes de formatear, o todo se muestra en cero.
export const formatMoney = (amount: number | string, currency = 'PYG') => {
  const value = Number(amount);
  return new Intl.NumberFormat('es-PY', { style: 'currency', currency: currency || 'PYG' }).format(Number.isFinite(value) ? value : 0);
};

export const formatTime = (value: string) =>
  new Intl.DateTimeFormat('es-PY', { timeZone: 'America/Asuncion', hour: '2-digit', minute: '2-digit', hour12: false }).format(toDate(value));

export const formatDateTime = (value: string) => toDate(value).toLocaleString('es-PY', { timeZone: 'America/Asuncion' });

export const todayKey = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Asuncion', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export const roleLabel = (role: string) =>
  role === 'CAJERO' ? 'caja' : role === 'COBRADOR' ? 'cobrador' : role === 'ADMIN' ? 'admin' : 'supervisor';

export const referenceText = (claim: Pick<BankClaim, 'referenceType' | 'referenceValue' | 'paymentRef' | 'collectorName'>) =>
  claim.referenceType === 'TICKET'
    ? `Ticket ${claim.referenceValue}`
    : claim.referenceType === 'CLIENTE'
      ? `Cliente ${claim.referenceValue}`
      : `Consulta ${claim.paymentRef ?? claim.referenceValue.slice(0, 8)}${claim.collectorName ? ` de ${claim.collectorName}` : ''}`;

/** "Tomada por caja HUGO · 10:32 · Ticket 4512" */
export const claimSummary = (claim: BankClaim) => {
  const who = (claim.claimedByName || claim.claimedByUsername || '').toUpperCase();
  const verb = claim.referenceType === 'CONSULTA' ? 'Conciliada por' : 'Tomada por';
  return `${verb} ${roleLabel(claim.claimedByRole)} ${who} · ${formatTime(claim.claimedAt)} · ${referenceText(claim)}`;
};

/** Resumen de todas las tomas de una transferencia, para cuando el pago se partió en varias. */
export const claimsSummary = (transfer: Pick<BankTransfer, 'claims' | 'currency'>) => {
  if (transfer.claims.length === 0) return '';
  if (transfer.claims.length === 1) return claimSummary(transfer.claims[0]);
  return `Repartida en ${transfer.claims.length}: ${transfer.claims
    .map((c) => `${formatMoney(c.amount, transfer.currency)} ${referenceText(c)}`)
    .join(' · ')}`;
};

/** Primera toma activa, que es la única en el caso normal de un pago entero. */
export const mainClaim = (transfer: Pick<BankTransfer, 'claims'>): BankClaim | null => transfer.claims[0] ?? null;

const MATCH_STYLES: Record<MatchStrength, { label: string; className: string }> = {
  FUERTE: { label: 'Coincide', className: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
  MEDIA: { label: 'Probable', className: 'bg-amber-100 text-amber-800 border-amber-300' },
  DEBIL: { label: 'Sin vínculo', className: 'bg-slate-100 text-slate-600 border-slate-300' },
};

/** Cuanta evidencia respalda una pareja consulta <-> transferencia. */
export const MatchBadge = ({ match }: { match: MatchAssessment }) => (
  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${MATCH_STYLES[match.strength].className}`} title={match.reason}>
    {match.conflicts?.length ? 'Datos distintos' : MATCH_STYLES[match.strength].label}
  </span>
);

const STATUS_STYLES: Record<BankTransferStatus, { label: string; badge: string; row: string }> = {
  [BankTransferStatus.DISPONIBLE]: {
    label: 'Disponible',
    badge: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    row: 'border-l-emerald-500 bg-white hover:bg-emerald-50/60',
  },
  [BankTransferStatus.PARCIAL]: {
    label: 'Parcial',
    badge: 'bg-sky-100 text-sky-800 border-sky-200',
    row: 'border-l-sky-500 bg-sky-50/40 hover:bg-sky-50',
  },
  [BankTransferStatus.TOMADA]: {
    label: 'Tomada',
    badge: 'bg-slate-200 text-slate-700 border-slate-300',
    row: 'border-l-slate-400 bg-slate-50 hover:bg-slate-100',
  },
  [BankTransferStatus.REVERSADA]: {
    label: 'Reversada',
    badge: 'bg-red-100 text-red-800 border-red-200',
    row: 'border-l-red-500 bg-red-50/60 hover:bg-red-50',
  },
  [BankTransferStatus.BLOQUEADA]: {
    label: 'En revisión',
    badge: 'bg-amber-100 text-amber-800 border-amber-200',
    row: 'border-l-amber-500 bg-amber-50/60 hover:bg-amber-50',
  },
};

export const statusStyle = (status: BankTransferStatus) => STATUS_STYLES[status];

export const BankStatusBadge = ({ status }: { status: BankTransferStatus }) => (
  <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border ${STATUS_STYLES[status].badge}`}>
    {STATUS_STYLES[status].label}
  </span>
);

/** Frescura del feed: hace cuanto el banco respondio bien. */
export const feedFreshness = (feed: BankFeedStatus | null, now: number) => {
  if (!feed) return { stale: false, label: 'Conectando…', tone: 'gray' as const };
  // Con la hora del servidor: una PC atrasada mostraría "hace 0 s" aunque no lleguen datos.
  const serverNow = now + (feed.clockOffsetMs ?? 0);
  const seconds = feed.lastSuccessAt ? Math.max(0, Math.round((serverNow - toDate(feed.lastSuccessAt).getTime()) / 1000)) : null;
  const staleAfter = Math.max(45, feed.intervalSeconds * 4);
  switch (feed.state) {
    case 'EN_VIVO':
      if (seconds !== null && seconds > staleAfter) return { stale: true, label: `Sin datos nuevos del banco hace ${seconds} s`, tone: 'amber' as const };
      return { stale: false, label: seconds === null ? 'En vivo' : `En vivo · hace ${seconds} s`, tone: 'green' as const };
    case 'EN_ESPERA':
      return { stale: false, label: 'Conectando con el banco…', tone: 'gray' as const };
    case 'FUERA_DE_HORARIO':
      return { stale: true, label: `Fuera de horario (${feed.hours})`, tone: 'gray' as const };
    case 'ERROR':
      return { stale: true, label: 'El banco no responde, reintentando…', tone: 'amber' as const };
    case 'DETENIDO':
      return { stale: true, label: 'Consulta al banco detenida', tone: 'red' as const };
    case 'SIN_CONFIGURAR':
      return { stale: true, label: 'Conexión al banco sin configurar', tone: 'red' as const };
    default:
      return { stale: true, label: 'Conexión al banco apagada', tone: 'gray' as const };
  }
};

const TONES = {
  green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  amber: 'bg-amber-50 text-amber-800 border-amber-200',
  red: 'bg-red-50 text-red-700 border-red-200',
  gray: 'bg-slate-100 text-slate-600 border-slate-200',
};
const DOTS = { green: 'bg-emerald-500 animate-pulse', amber: 'bg-amber-500', red: 'bg-red-500', gray: 'bg-slate-400' };

export const FeedPill = ({ label, tone, mock }: { label: string; tone: keyof typeof TONES; mock: boolean }) => (
  <span className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border text-xs font-semibold ${TONES[tone]}`}>
    <span className={`w-2 h-2 rounded-full ${DOTS[tone]}`} />
    {label}
    {mock && <span className="ml-1 px-1.5 rounded bg-fuchsia-100 text-fuchsia-700 border border-fuchsia-200 text-[10px]">SIMULADO</span>}
  </span>
);

export const transferMatches = (t: BankTransfer, search: string) => {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  const digits = q.replace(/[.\s]/g, '');
  const haystack = [
    t.senderName,
    t.senderNote,
    t.concept,
    t.bankDocNumber,
    ...t.claims.flatMap((c) => [c.referenceValue, c.claimedByName, c.paymentRef, c.clientName]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(q) || (/^\d+$/.test(digits) && String(t.amount).includes(digits));
};
