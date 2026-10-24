import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../services/api';
import { createRealtimeSocket } from '../services/realtime';
import { parseDbTimestamp } from '../services/date';
import { AuditLog } from '../types';

// Ver nota en SharedDashboardView: por debajo de 5 min Neon nunca se suspende.
const FALLBACK_POLL_MS = 15 * 60 * 1000;

const safeJson = (value?: string | null) => {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

export const ActivityFeedView = ({ showToast }: { showToast: (t: 'success' | 'error' | 'info', m: string) => void }) => {
  const [items, setItems] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/payments/proof-views', { params: { limit: 80 } });
      setItems(Array.isArray(data) ? data : []);
    } catch {
      showToast('error', 'No se pudo cargar la actividad.');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();

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
    return items.map((i) => {
      const meta = safeJson(i.metadata);
      return { ...i, _meta: meta as any };
    });
  }, [items]);

  return (
    <div className="space-y-4">
      <div className="bg-white p-4 rounded-lg shadow-sm border flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">Actividad (comprobantes consultados)</h2>
          <p className="text-xs text-gray-500 mt-1">Muestra quién abrió un comprobante para revisarlo.</p>
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

          {normalized.map((log) => (
            <div key={log.id} className="p-4 hover:bg-gray-50">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-800 truncate">
                    {log.actorUsername || log.userId} consultó un comprobante
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {(parseDbTimestamp(log.timestamp) ?? new Date(log.timestamp)).toLocaleString('es-PY', { timeZone: 'America/Asuncion' })}
                    {log.paymentId ? (
                      <span className="ml-2 font-mono text-[11px] text-gray-400">Pago: {log.paymentId.slice(0, 8)}</span>
                    ) : null}
                  </div>

                  {(log.payment || log._meta) && (
                    <div className="text-xs text-gray-600 mt-2 flex flex-wrap gap-x-3 gap-y-1">
                      {log.payment?.clientName ? <span>Nombre: <b>{String(log.payment.clientName)}</b></span> : null}
                      {(log.payment?.clientCode || log._meta?.clientCode) ? <span>Código: <b>{String(log.payment?.clientCode || log._meta?.clientCode)}</b></span> : null}
                      {(log.payment?.paymentRef || log._meta?.ref) ? <span>Ref: <b>{String(log.payment?.paymentRef || log._meta?.ref)}</b></span> : null}
                      {(typeof log.payment?.amount === 'number' || typeof log._meta?.amount === 'number') ? (
                        <span>
                          Monto:{' '}
                          <b>
                            {new Intl.NumberFormat('es-PY', { style: 'currency', currency: 'PYG' }).format(
                              (log.payment?.amount ?? log._meta?.amount) as number,
                            )}
                          </b>
                        </span>
                      ) : null}
                      {(log.payment?.sourceBank || log._meta?.bank) ? <span>Banco: <b>{String(log.payment?.sourceBank || log._meta?.bank)}</b></span> : null}
                    </div>
                  )}
                </div>

                <div className="shrink-0">
                  <span className="text-[11px] px-2 py-1 rounded-full bg-slate-100 text-slate-700 border">
                    Consultado
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
