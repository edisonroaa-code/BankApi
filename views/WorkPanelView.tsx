import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle, Clock, Eye, RefreshCw, Search, X, XCircle } from 'lucide-react';
import { api } from '../services/api';
import { parseDbTimestamp } from '../services/date';
import { createRealtimeSocket, PaymentsRealtimeEvent } from '../services/realtime';
import { fetchPaymentDetail, fetchPaymentsPage, upsertPayment } from '../services/payments';
import { onPaymentPrinted } from '../services/print-events';
import { destinationLabel } from '../services/payment-destination';
import { PaymentTimelineModal } from '../components/PaymentTimelineModal';
import { Payment, PaymentState, PaymentSummary, User, UserRole } from '../types';
import { SharedDashboardView } from './SharedDashboardView';

type Tab = 'WORK' | 'ACTIVITY';

// Respaldo por si el WebSocket esta bloqueado. Debe superar los 5 min de
// autosuspend de Neon: un poll mas corto deja el compute encendido toda la
// jornada y agota la cuota mensual sin trabajo real.
const FALLBACK_POLL_MS = 15 * 60 * 1000;

const isClaimActive = (p: Payment) => {
  if (!p.reviewClaimedById || !p.reviewClaimExpiresAt) return false;
  const exp = (parseDbTimestamp(p.reviewClaimExpiresAt) ?? new Date(p.reviewClaimExpiresAt)).getTime();
  return Number.isFinite(exp) && exp > Date.now();
};

const getCreatedByName = (p: Payment) => {
  const createdBy = p.createdBy as any;
  if (createdBy && typeof createdBy === 'object') {
    return createdBy.name || createdBy.username || createdBy.id || 'Cobrador';
  }
  return 'Cobrador';
};

const getCreatedById = (p: Payment) => {
  const createdBy = p.createdBy as any;
  if (createdBy && typeof createdBy === 'object' && createdBy.id) return String(createdBy.id);
  return (p as any).createdById ? String((p as any).createdById) : null;
};

const getStage = (p: Payment) => {
  if (p.status === PaymentState.RECHAZADO) return 'NO_INGRESO';
  if (p.cashPaidAt) return 'PAGO_EN_CAJA';
  if (p.printedAt) return 'IMPRESA';
  if (p.status === PaymentState.CONFIRMADO || p.status === PaymentState.CONFIRMADO_MANUAL) return 'INGRESO';
  if (p.status === PaymentState.EN_REVISION || isClaimActive(p)) return 'EN_REVISION';
  return 'CONSULTADA';
};

const stageLabel: Record<string, string> = {
  CONSULTADA: 'Transferencia consultada',
  EN_REVISION: 'En revisión',
  INGRESO: 'Ingreso',
  NO_INGRESO: 'No ingreso',
  IMPRESA: 'Ticket impreso',
  PAGO_EN_CAJA: 'Pago en caja efectuado',
};

const stageKind = (stage: string) => {
  if (stage === 'NO_INGRESO') return 'bad';
  if (stage === 'INGRESO' || stage === 'IMPRESA' || stage === 'PAGO_EN_CAJA') return 'ok';
  return 'info';
};

const formatWhen = (value?: string | null) => {
  if (!value) return '--';
  const parsed = parseDbTimestamp(value) ?? new Date(value);
  return parsed.toLocaleString('es-PY', { timeZone: 'America/Asuncion' });
};

const formatMoney = (value: number) =>
  new Intl.NumberFormat('es-PY', { style: 'currency', currency: 'PYG' }).format(Number.isFinite(value) ? value : 0);

const getCreatedAt = (value: string) => parseDbTimestamp(value) ?? new Date(value);

export const WorkPanelView = ({
  showToast,
  user,
}: {
  showToast: (t: 'success' | 'error' | 'info', m: string) => void;
  user: User;
}) => {
  const [tab, setTab] = useState<Tab>('WORK');
  const [items, setItems] = useState<Payment[]>([]);
  const [itemsPage, setItemsPage] = useState(1);
  const [itemsTotalPages, setItemsTotalPages] = useState(1);
  const [itemsTotal, setItemsTotal] = useState(0);
  const [kpis, setKpis] = useState<any>(null);
  const [monthSummary, setMonthSummary] = useState<PaymentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  const [mode, setMode] = useState<'OPEN' | 'TODAY'>('OPEN');
  const [timelinePaymentId, setTimelinePaymentId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const OVERDUE_MINUTES = 10;

  const canSeeMetrics = user.role === UserRole.ADMIN || user.role === UserRole.SUPERVISOR;

  const monthNames = useMemo(
    () => [
      'Enero',
      'Febrero',
      'Marzo',
      'Abril',
      'Mayo',
      'Junio',
      'Julio',
      'Agosto',
      'Septiembre',
      'Octubre',
      'Noviembre',
      'Diciembre',
    ],
    [],
  );

  const [reportYear, setReportYear] = useState(() => new Date().getFullYear());
  const [reportMonth, setReportMonth] = useState(() => new Date().getMonth());

  const reportRange = useMemo(() => {
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const startDate = `${reportYear}-${pad2(reportMonth + 1)}-01`;
    const endDate = `${reportYear}-${pad2(reportMonth + 1)}-${pad2(new Date(reportYear, reportMonth + 1, 0).getDate())}`;
    return { startDate, endDate };
  }, [reportMonth, reportYear]);

  const monthTotals = useMemo(() => {
    const find = (s: PaymentState) => monthSummary.find((x) => x.status === s);
    const confirmed = (find(PaymentState.CONFIRMADO)?.total || 0) + (find(PaymentState.CONFIRMADO_MANUAL)?.total || 0);
    const confirmedCount = (find(PaymentState.CONFIRMADO)?.count || 0) + (find(PaymentState.CONFIRMADO_MANUAL)?.count || 0);
    const rejected = find(PaymentState.RECHAZADO)?.total || 0;
    const rejectedCount = find(PaymentState.RECHAZADO)?.count || 0;
    const declared = monthSummary.reduce((acc, curr) => acc + (curr.total || 0), 0);
    const declaredCount = monthSummary.reduce((acc, curr) => acc + (curr.count || 0), 0);
    return { confirmed, confirmedCount, rejected, rejectedCount, declared, declaredCount };
  }, [monthSummary]);

  const load = useCallback(async (page = 1, selectedMode = mode) => {
    try {
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const data = await fetchPaymentsPage({
        page,
        pageSize: 50,
        globalScope: true,
        statuses: selectedMode === 'OPEN'
          ? [
            PaymentState.PENDIENTE_VERIFICACION,
            PaymentState.EN_REVISION,
            PaymentState.CONFIRMADO,
            PaymentState.CONFIRMADO_MANUAL,
          ]
          : undefined,
        startDate: selectedMode === 'TODAY' ? today : undefined,
        endDate: selectedMode === 'TODAY' ? today : undefined,
      });
      setItems(data.items);
      setItemsPage(data.page);
      setItemsTotalPages(data.totalPages);
      setItemsTotal(data.total);
      setInitialLoad(false);
      if (canSeeMetrics) {
        api
          .get('/payments/kpis', { params: { overdueMinutes: OVERDUE_MINUTES } })
          .then((res) => setKpis(res.data))
          .catch(() => { });
      } else {
        setKpis(null);
      }
    } catch {
      setInitialLoad(false);
      showToast('error', 'No se pudo cargar el panel de trabajo.');
    }
  }, [canSeeMetrics, mode, showToast]);

  const loadMonthSummary = useCallback(async () => {
    if (!canSeeMetrics) return;
    try {
      const res = await api.get('/payments/summary', { params: reportRange });
      setMonthSummary(Array.isArray(res.data) ? (res.data as PaymentSummary[]) : []);
    } catch {
      showToast('error', 'No se pudieron cargar las métricas del mes.');
    }
  }, [canSeeMetrics, reportRange, showToast]);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([load(itemsPage, mode), loadMonthSummary()]);
    } finally {
      setLoading(false);
    }
  }, [itemsPage, load, loadMonthSummary, mode]);

  useEffect(() => {
    load(itemsPage, mode);

    const socket = createRealtimeSocket();
    socket.on('payments:changed', (evt: PaymentsRealtimeEvent) => {
      const shouldNotify = user.role !== UserRole.COBRADOR && evt?.type === 'PAYMENT_CREATED';
      if (shouldNotify && typeof window !== 'undefined' && 'Notification' in window) {
        try {
          if (Notification.permission === 'granted') {
            new Notification('Nueva transferencia consultada', { body: 'Se registró una nueva consulta de transferencia.' });
          } else if (Notification.permission === 'default') {
            Notification.requestPermission().catch(() => { });
          }
        } catch {
          // ignore
        }
      }

      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (!evt?.paymentId) {
        load(itemsPage, mode);
        return;
      }
      fetchPaymentDetail(evt.paymentId)
        .then((payment) => {
          setItems((prev) => upsertPayment(prev, payment).slice(0, 50));
          if (canSeeMetrics) {
            api
              .get('/payments/kpis', { params: { overdueMinutes: OVERDUE_MINUTES } })
              .then((res) => setKpis(res.data))
              .catch(() => { });
          }
        })
        .catch(() => { });
    });

    // Fallback polling (e.g., if WS is blocked)
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      load(itemsPage, mode);
    }, FALLBACK_POLL_MS);

    return () => {
      clearInterval(interval);
      socket.disconnect();
    };
  }, [itemsPage, load, mode, user.role]);

  useEffect(() => {
    loadMonthSummary();
  }, [loadMonthSummary]);

  useEffect(() => {
    if (!canSeeMetrics) return;
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      loadMonthSummary();
    }, FALLBACK_POLL_MS);
    return () => clearInterval(interval);
  }, [canSeeMetrics, loadMonthSummary]);

  const filtered = useMemo(() => {
    const now = new Date();
    const startToday = new Date(now);
    startToday.setHours(0, 0, 0, 0);

    let base =
      mode === 'TODAY'
        ? items.filter((p) => getCreatedAt(p.createdAt).getTime() >= startToday.getTime())
        : items.filter((p) => p.status !== PaymentState.RECHAZADO && !p.cashPaidAt);

    // Apply search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      base = base.filter((p) =>
        (p.paymentRef || '').toLowerCase().includes(q) ||
        (p.clientCode || '').toLowerCase().includes(q) ||
        (p.clientName || '').toLowerCase().includes(q) ||
        (p.sourceBank || '').toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q)
      );
    }

    // Newest first (más nuevos arriba)
    return [...base].sort((a, b) => getCreatedAt(b.createdAt).getTime() - getCreatedAt(a.createdAt).getTime());
  }, [items, mode, searchQuery]);

  const summary = useMemo(() => {
    const counts = {
      consulted: 0,
      review: 0,
      ok: 0,
      bad: 0,
      printed: 0,
      cash: 0,
    };
    for (const p of filtered) {
      const stage = getStage(p);
      if (stage === 'CONSULTADA') counts.consulted += 1;
      if (stage === 'EN_REVISION') counts.review += 1;
      if (stage === 'INGRESO') counts.ok += 1;
      if (stage === 'NO_INGRESO') counts.bad += 1;
      if (stage === 'IMPRESA') counts.printed += 1;
      if (stage === 'PAGO_EN_CAJA') counts.cash += 1;
    }
    return counts;
  }, [filtered]);

  // Confirmado "Sí, salió impreso" en esta app: la etapa pasa a "Ticket impreso" al instante.
  useEffect(() => onPaymentPrinted((printed) => {
    setItems((prev) => (prev.some((p) => p.id === printed.id) ? upsertPayment(prev, printed) : prev));
  }), []);

  const markCashPaid = useCallback(
    async (p: Payment) => {
      try {
        const { data } = await api.post(`/payments/${p.id}/cash-paid`);
        setItems((prev) => prev.map((x) => (x.id === data.id ? data : x)));
        showToast('success', 'Marcado como pago en caja.');
      } catch (e: any) {
        const msg = e?.response?.data?.message;
        showToast('error', msg ? String(msg) : 'No se pudo marcar caja.');
      }
    },
    [showToast],
  );

  return (
    <div className="space-y-4">
      <div className="bg-white p-4 rounded-lg shadow-sm border flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Panel de trabajo</h2>
          <p className="text-sm text-gray-500 mt-1">
            Una tarjeta por transferencia. Se actualiza por etapas (consultada → aprobada/rechazada → impresa → caja).
          </p>
          {kpis && (
            <div className="text-xs text-gray-500 mt-2">
              Promedio hoy: <b>{kpis?.period?.avgMinutes ?? '--'} min</b> · Resueltos: <b>{kpis?.period?.decisions ?? 0}</b>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTab('WORK')}
            className={`px-3 py-2 text-sm rounded-lg border ${tab === 'WORK' ? 'bg-slate-900 text-white border-slate-900' : 'bg-white hover:bg-gray-50'}`}
          >
            Panel
          </button>
          <button
            type="button"
            onClick={() => setTab('ACTIVITY')}
            className={`px-3 py-2 text-sm rounded-lg border ${tab === 'ACTIVITY' ? 'bg-slate-900 text-white border-slate-900' : 'bg-white hover:bg-gray-50'}`}
          >
            Actividad
          </button>
          <button
            type="button"
            onClick={refreshAll}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm rounded-lg border bg-white hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Actualizar
          </button>
        </div>
      </div>

      {tab === 'ACTIVITY' ? (
        <SharedDashboardView showToast={showToast} />
      ) : (
        <>
          {canSeeMetrics && (
            <div className="bg-white p-3 rounded-lg border">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-800">Métricas del mes</div>
                  <div className="text-[11px] text-gray-500">
                    Período: <b>{reportRange.startDate}</b> a <b>{reportRange.endDate}</b>
                  </div>
                </div>

                <div className="flex items-center gap-2 ml-auto">
                  <span className="text-[11px] text-gray-600">Mes</span>
                  <select
                    value={reportMonth}
                    onChange={(e) => setReportMonth(parseInt(e.target.value, 10))}
                    className="text-xs px-2 py-1.5 rounded border bg-white"
                  >
                    {monthNames.map((name, idx) => (
                      <option key={name} value={idx}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-gray-600">Año</span>
                  <input
                    type="number"
                    value={reportYear}
                    onChange={(e) => setReportYear(parseInt(e.target.value, 10) || new Date().getFullYear())}
                    className="w-24 text-xs px-2 py-1.5 rounded border bg-white"
                  />
                </div>
              </div>

              <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="rounded border bg-slate-50 p-2">
                  <div className="text-[11px] text-gray-500">Ingresadas</div>
                  <div className="text-sm font-semibold text-slate-800">{formatMoney(monthTotals.confirmed)}</div>
                  <div className="text-[11px] text-gray-500">{monthTotals.confirmedCount} operaciones</div>
                </div>
                <div className="rounded border bg-slate-50 p-2">
                  <div className="text-[11px] text-gray-500">No ingreso</div>
                  <div className="text-sm font-semibold text-slate-800">{formatMoney(monthTotals.rejected)}</div>
                  <div className="text-[11px] text-gray-500">{monthTotals.rejectedCount} operaciones</div>
                </div>
                <div className="rounded border bg-slate-50 p-2">
                  <div className="text-[11px] text-gray-500">Consultadas</div>
                  <div className="text-sm font-semibold text-slate-800">{formatMoney(monthTotals.declared)}</div>
                  <div className="text-[11px] text-gray-500">{monthTotals.declaredCount} operaciones</div>
                </div>
              </div>
            </div>
          )}

          <div className="bg-white p-3 rounded-lg border flex flex-wrap items-center gap-2 text-sm">
            <button
              type="button"
              onClick={() => setMode('OPEN')}
              className={`px-3 py-1.5 rounded border ${mode === 'OPEN' ? 'bg-slate-900 text-white border-slate-900' : 'bg-white hover:bg-gray-50'}`}
            >
              Abiertas
            </button>
            <button
              type="button"
              onClick={() => setMode('TODAY')}
              className={`px-3 py-1.5 rounded border ${mode === 'TODAY' ? 'bg-slate-900 text-white border-slate-900' : 'bg-white hover:bg-gray-50'}`}
            >
              Hoy
            </button>
            <span className="text-gray-600 ml-2">
              Consultadas: <b>{summary.consulted}</b> · En revisión: <b>{summary.review}</b> · Ingreso: <b>{summary.ok}</b> · No ingreso:{' '}
              <b>{summary.bad}</b> · Impresas: <b>{summary.printed}</b> · Caja: <b>{summary.cash}</b>
            </span>
          </div>

          {/* Search bar */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="search"
              placeholder="Buscar por referencia, código, cliente, banco..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-9 py-2.5 border border-gray-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none transition-shadow"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          <div className="bg-white rounded-lg shadow-sm border overflow-hidden">
            <div className="divide-y">
              {initialLoad ? (
                <div className="p-4 space-y-4">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="animate-pulse space-y-2">
                      <div className="flex items-start gap-3">
                        <div className="skeleton w-5 h-5 rounded-full shrink-0 mt-0.5" />
                        <div className="flex-1 space-y-2">
                          <div className="skeleton h-4 w-3/4" />
                          <div className="skeleton h-3 w-1/2" />
                          <div className="skeleton h-3 w-full" />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : filtered.length === 0 ? (
                <div className="p-8 text-center text-gray-400 text-sm">
                  {searchQuery ? 'No se encontraron resultados para tu búsqueda.' : 'Sin operaciones para mostrar.'}
                  {searchQuery && (
                    <button type="button" onClick={() => setSearchQuery('')} className="block mx-auto mt-2 text-blue-600 hover:underline text-xs">Limpiar búsqueda</button>
                  )}
                </div>
              ) : null}

              {filtered.map((p) => {
                const stage = getStage(p);
                const kind = stageKind(stage);
                const Icon = kind === 'ok' ? CheckCircle : kind === 'bad' ? XCircle : Eye;
                const iconColor = kind === 'ok' ? 'text-green-600' : kind === 'bad' ? 'text-red-600' : 'text-blue-600';

                const createdByName = getCreatedByName(p);
                const claimedBy = p.reviewClaimedByName || p.reviewClaimedByUsername || p.reviewClaimedById || null;

                const createdAt = getCreatedAt(p.createdAt);
                const ageMinutes = Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / 60000));
                const createdById = getCreatedById(p);
                const canMarkCash =
                  !!p.printedAt &&
                  !p.cashPaidAt &&
                  (p.status === PaymentState.CONFIRMADO || p.status === PaymentState.CONFIRMADO_MANUAL) &&
                  (
                    user.role === UserRole.ADMIN ||
                    user.role === UserRole.SUPERVISOR ||
                    (user.role === UserRole.COBRADOR && !!createdById && createdById === user.id)
                  );

                return (
                  <div key={p.id} className="p-4 hover:bg-gray-50">
                    <div className="flex items-start gap-3">
                      <Icon className={`w-5 h-5 mt-0.5 ${iconColor}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-base font-semibold text-slate-800 truncate">
                              {createdByName} consultó una transferencia
                            </div>
                            <div className="text-base text-gray-500 mt-1 flex flex-wrap gap-x-3 gap-y-1 items-center">
                              <span>{createdAt.toLocaleString('es-PY', { timeZone: 'America/Asuncion' })}</span>
                              <span className="inline-flex items-center gap-1">
                                <Clock className="w-3 h-3" /> {ageMinutes} min
                              </span>
                              <span className="px-2 py-0.5 rounded-full border bg-white text-slate-700">
                                Etapa: <b>{stageLabel[stage] || stage}</b>
                              </span>
                              {isClaimActive(p) && claimedBy ? (
                                <span className="px-2 py-0.5 rounded-full border bg-amber-50 text-amber-900 border-amber-200">
                                  Tomado por: <b>{claimedBy}</b>
                                </span>
                              ) : null}
                            </div>
                          </div>
                          <span className="text-xs px-2 py-1 rounded-full bg-slate-100 text-slate-700 border shrink-0 font-mono">
                            {p.id.slice(0, 8)}
                          </span>
                        </div>

                        <div className="text-base text-gray-600 mt-2 flex flex-wrap gap-x-3 gap-y-1">
                          {p.clientName ? (
                            <span>
                              Nombre: <b>{p.clientName}</b>
                            </span>
                          ) : null}
                          {p.clientCode ? (
                            <span>
                              Código: <b>{p.clientCode}</b>
                            </span>
                          ) : null}
                          {p.paymentRef ? (
                            <span>
                              Ref: <b>{p.paymentRef}</b>
                            </span>
                          ) : null}
                          <span>
                            Monto:{' '}
                            <b>{new Intl.NumberFormat('es-PY', { style: 'currency', currency: 'PYG' }).format(p.amount)}</b>
                          </span>
                          {p.sourceBank ? (
                            <span>
                              Banco origen: <b>{p.sourceBank}</b>
                            </span>
                          ) : null}
                          <span>
                            Cuenta destino: <b>{destinationLabel(p.isAtlasAccount)}</b>
                          </span>
                        </div>

                        <div className="mt-2 flex flex-wrap gap-2 text-xs">
                          <span className="px-2 py-0.5 rounded-full border bg-slate-50 text-slate-700 border-slate-200">
                            1 Consultada
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full border ${stage === 'NO_INGRESO'
                                ? 'bg-red-50 text-red-800 border-red-200'
                                : stage === 'INGRESO' || stage === 'IMPRESA' || stage === 'PAGO_EN_CAJA'
                                  ? 'bg-green-50 text-green-800 border-green-200'
                                  : stage === 'EN_REVISION'
                                    ? 'bg-amber-50 text-amber-900 border-amber-200'
                                    : 'bg-slate-50 text-slate-700 border-slate-200'
                              }`}
                          >
                            2{' '}
                            {stage === 'NO_INGRESO'
                              ? 'No ingreso'
                              : stage === 'INGRESO' || stage === 'IMPRESA' || stage === 'PAGO_EN_CAJA'
                                ? 'Ingreso'
                                : stage === 'EN_REVISION'
                                  ? 'En revisión'
                                  : 'Pendiente'}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full border ${p.printedAt ? 'bg-slate-900 text-white border-slate-900' : 'bg-slate-50 text-slate-700 border-slate-200'
                              }`}
                          >
                            3 Ticket
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full border ${p.cashPaidAt ? 'bg-slate-900 text-white border-slate-900' : 'bg-slate-50 text-slate-700 border-slate-200'
                              }`}
                          >
                            4 Caja
                          </span>
                        </div>

                        <div className="text-xs text-gray-500 mt-2 flex flex-wrap gap-x-4 gap-y-1">
                          <span>Ingreso: <b>{formatWhen(p.verifiedAt)}</b></span>
                          <span>Impreso: <b>{formatWhen(p.printedAt)}</b></span>
                          <span>Caja: <b>{formatWhen(p.cashPaidAt)}</b></span>
                          {p.cashPaidAt ? (
                            <span>
                              Caja por: <b>{p.cashPaidByName || p.cashPaidByUsername || p.cashPaidById || '—'}</b>
                            </span>
                          ) : null}
                        </div>

                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => setTimelinePaymentId(p.id)}
                            className="px-3 py-2 text-sm rounded border bg-white hover:bg-gray-50"
                          >
                            Línea de vida
                          </button>
                          {canMarkCash && (
                            <button
                              type="button"
                              onClick={() => markCashPaid(p)}
                              className="px-3 py-2 text-sm rounded border bg-green-600 text-white hover:bg-green-700"
                            >
                              Marcar: pago en caja efectuado
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-between gap-3 p-3 border-t bg-slate-50">
              <span className="text-xs text-gray-500">
                Página {itemsPage} de {itemsTotalPages} · {itemsTotal} registros
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={itemsPage <= 1}
                  onClick={() => load(itemsPage - 1, mode)}
                  className="px-3 py-1.5 text-xs rounded border bg-white disabled:opacity-40"
                >
                  Anterior
                </button>
                <button
                  type="button"
                  disabled={itemsPage >= itemsTotalPages}
                  onClick={() => load(itemsPage + 1, mode)}
                  className="px-3 py-1.5 text-xs rounded border bg-white disabled:opacity-40"
                >
                  Siguiente
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      <PaymentTimelineModal
        open={!!timelinePaymentId}
        paymentId={timelinePaymentId}
        onClose={() => setTimelinePaymentId(null)}
      />
    </div>
  );
};
