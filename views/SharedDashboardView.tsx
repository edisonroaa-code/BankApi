import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle, Eye, RefreshCw, XCircle } from 'lucide-react';
import { api } from '../services/api';
import { createRealtimeSocket } from '../services/realtime';
import { parseDbTimestamp } from '../services/date';
import { AuditLog } from '../types';

// Respaldo por si el WebSocket esta bloqueado. Debe superar los 5 min de
// autosuspend de Neon: un poll mas corto deja el compute encendido toda la
// jornada y agota la cuota mensual sin trabajo real.
const FALLBACK_POLL_MS = 15 * 60 * 1000;

const safeJson = (value?: string | null) => {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const actionLabel = (action: string) => {
  const labels: Record<string, string> = {
    PAYMENT_CREATED: 'Transferencia consultada',
    PAYMENT_SENT_TO_REVIEW: 'En revisión',
    PAYMENT_REVIEW_CLAIMED: 'Caso tomado por gerente',
    PAYMENT_REVIEW_RELEASED: 'Caso liberado',
    PAYMENT_PROOF_VIEWED: 'Comprobante consultado',
    PAYMENT_CONFIRMED_MANUAL: 'Ingreso',
    PAYMENT_MATCH_CONFIRMED: 'Ingreso',
    PAYMENT_AUTO_CONFIRMED: 'Ingreso',
    PAYMENT_REJECTED: 'No ingreso',
    PAYMENT_DECISION_UNDONE: 'Decisión anulada',
    PAYMENT_PRINTED: 'Ticket impreso',
    PAYMENT_CASH_PAID: 'Pago en caja efectuado',
    MATCHING_TRIGGERED: 'Conciliación ejecutada',
    PAYMENT_BANK_RECONCILED: 'Conciliada con transferencia del banco',
    PAYMENT_BANK_RECONCILIATION_VOIDED: 'Conciliación bancaria anulada',
  };
  return labels[action] || action;
};

const actionKind = (action: string) => {
  if (action === 'PAYMENT_REJECTED') return 'bad';
  if (action === 'PAYMENT_PROOF_VIEWED' || action === 'PAYMENT_SENT_TO_REVIEW' || action === 'PAYMENT_REVIEW_CLAIMED' || action === 'PAYMENT_REVIEW_RELEASED' || action === 'PAYMENT_DECISION_UNDONE') return 'info';
  if (action === 'PAYMENT_CONFIRMED_MANUAL' || action === 'PAYMENT_MATCH_CONFIRMED' || action === 'PAYMENT_AUTO_CONFIRMED' || action === 'PAYMENT_BANK_RECONCILED') return 'ok';
  return 'neutral';
};

export const SharedDashboardView = ({ showToast }: { showToast: (t: 'success' | 'error' | 'info', m: string) => void }) => {
  const [items, setItems] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/payments/activity', { params: { limit: 120 } });
      setItems(Array.isArray(data) ? data : []);
    } catch {
      showToast('error', 'No se pudo cargar la actividad.');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();

    // La actualizacion en vivo la empuja el WebSocket, no el poll.
    const socket = createRealtimeSocket();
    let debounce: ReturnType<typeof setTimeout> | null = null;
    socket.on('payments:changed', () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => load(), 500);
    });

    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      load();
    }, FALLBACK_POLL_MS);

    return () => {
      if (debounce) clearTimeout(debounce);
      clearInterval(interval);
      socket.disconnect();
    };
  }, [load]);

  const normalized = useMemo(() => {
    return items.map((i) => ({ ...i, _meta: safeJson(i.metadata) as any }));
  }, [items]);

  const summary = useMemo(() => {
    const counts = {
      viewed: 0,
      ok: 0,
      bad: 0,
      review: 0,
    };
    for (const it of items) {
      if (it.action === 'PAYMENT_PROOF_VIEWED') counts.viewed += 1;
      if (it.action === 'PAYMENT_SENT_TO_REVIEW') counts.review += 1;
      if (it.action === 'PAYMENT_CONFIRMED_MANUAL' || it.action === 'PAYMENT_MATCH_CONFIRMED' || it.action === 'PAYMENT_AUTO_CONFIRMED') counts.ok += 1;
      if (it.action === 'PAYMENT_REJECTED') counts.bad += 1;
    }
    return counts;
  }, [items]);

  return (
    <div className="space-y-4">
      <div className="bg-white p-4 rounded-lg shadow-sm border flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">Dashboard común (en vivo)</h2>
          <p className="text-xs text-gray-500 mt-1">Consultas, verificaciones, ingresos y rechazos.</p>
          <div className="flex flex-wrap gap-2 mt-3 text-xs">
            <span className="px-2 py-1 rounded-full border bg-slate-50 text-slate-700">Consultas: <b>{summary.viewed}</b></span>
            <span className="px-2 py-1 rounded-full border bg-slate-50 text-slate-700">En revisión: <b>{summary.review}</b></span>
            <span className="px-2 py-1 rounded-full border bg-green-50 text-green-800 border-green-200">Ingresos: <b>{summary.ok}</b></span>
            <span className="px-2 py-1 rounded-full border bg-red-50 text-red-800 border-red-200">No ingreso: <b>{summary.bad}</b></span>
          </div>
        </div>

        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3 py-2 text-sm rounded-lg border bg-white hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Actualizar
        </button>
      </div>

      <div className="bg-white rounded-lg shadow-sm border overflow-hidden">
        <div className="divide-y">
          {normalized.length === 0 && (
            <div className="p-8 text-center text-gray-400 text-sm">Sin actividad registrada.</div>
          )}

          {normalized.map((log) => {
            const kind = actionKind(log.action);
            const Icon = kind === 'ok' ? CheckCircle : kind === 'bad' ? XCircle : Eye;
            const iconColor = kind === 'ok' ? 'text-green-600' : kind === 'bad' ? 'text-red-600' : 'text-blue-600';
            const meta = log._meta;
            const payment = log.payment;

            const ref = payment?.paymentRef || meta?.ref || null;
            const clientCode = payment?.clientCode || meta?.clientCode || null;
            const clientName = payment?.clientName || meta?.clientName || null;
            const bank = payment?.sourceBank || meta?.bank || null;
            const amount =
              typeof payment?.amount === 'number'
                ? payment.amount
                : typeof meta?.amount === 'number'
                  ? meta.amount
                  : null;

            return (
              <div key={log.id} className="p-4 hover:bg-gray-50">
                <div className="flex items-start gap-3">
                  <Icon className={`w-5 h-5 mt-0.5 ${iconColor}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-800 truncate">
                          {actionLabel(log.action)}
                        </div>
                        <div className="text-sm text-gray-500 mt-1">
                          {(parseDbTimestamp(log.timestamp) ?? new Date(log.timestamp)).toLocaleString('es-PY', { timeZone: 'America/Asuncion' })} · Por: <b>{log.actorUsername || log.userId}</b>
                          {log.paymentId ? <span className="ml-2 font-mono text-[11px] text-gray-400">Pago: {log.paymentId.slice(0, 8)}</span> : null}
                        </div>
                      </div>
                      <span className="text-[11px] px-2 py-1 rounded-full bg-slate-100 text-slate-700 border shrink-0">
                        {actionLabel(log.action)}
                      </span>
                    </div>

                    {(ref || clientCode || clientName || bank || typeof amount === 'number') && (
                      <div className="text-sm text-gray-600 mt-2 flex flex-wrap gap-x-3 gap-y-1">
                        {clientName ? <span>Nombre: <b>{String(clientName)}</b></span> : null}
                        {clientCode ? <span>Código: <b>{String(clientCode)}</b></span> : null}
                        {ref ? <span>Ref: <b>{String(ref)}</b></span> : null}
                        {typeof amount === 'number' ? (
                          <span>Monto: <b>{new Intl.NumberFormat('es-PY', { style: 'currency', currency: 'PYG' }).format(amount)}</b></span>
                        ) : null}
                        {bank ? <span>Banco: <b>{String(bank)}</b></span> : null}
                      </div>
                    )}
                    {!(ref || clientCode || clientName || bank || typeof amount === 'number') && log.metadata && (
                      <div className="text-sm text-gray-600 mt-2 break-words">{log.metadata}</div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};


