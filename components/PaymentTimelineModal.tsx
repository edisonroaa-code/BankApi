import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle, Clock, Eye, Loader2, RefreshCw, X, XCircle } from 'lucide-react';
import { api } from '../services/api';
import { parseDbTimestamp } from '../services/date';
import { AuditLog } from '../types';
import { auditActionLabel as actionLabel, auditActor, auditStateChange, describeAudit } from '../services/audit-format';

const actionIcon = (code: string) => {
  if (code === 'PAYMENT_REJECTED') return { Icon: XCircle, cls: 'text-red-600' };
  if (code === 'PAYMENT_CONFIRMED_MANUAL' || code === 'PAYMENT_AUTO_CONFIRMED' || code === 'PAYMENT_MATCH_CONFIRMED' || code === 'PAYMENT_BANK_RECONCILED' || code === 'PAYMENT_CASH_PAID')
    return { Icon: CheckCircle, cls: 'text-green-600' };
  if (code === 'PAYMENT_PROOF_VIEWED') return { Icon: Eye, cls: 'text-blue-600' };
  if (code === 'PAYMENT_PRINTED') return { Icon: CheckCircle, cls: 'text-slate-700' };
  if (code === 'PAYMENT_SENT_TO_REVIEW' || code === 'PAYMENT_REVIEW_CLAIMED' || code === 'PAYMENT_REVIEW_RELEASED') return { Icon: Clock, cls: 'text-amber-700' };
  return { Icon: AlertCircle, cls: 'text-slate-600' };
};

export const PaymentTimelineModal = ({
  paymentId,
  open,
  onClose,
}: {
  paymentId: string | null;
  open: boolean;
  onClose: () => void;
}) => {
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<AuditLog[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!paymentId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/payments/${paymentId}/audit`);
      setItems(Array.isArray(res.data) ? res.data : []);
    } catch (e: any) {
      setItems([]);
      const msg = e?.response?.data?.message;
      setError(typeof msg === 'string' ? msg : 'No se pudo cargar la auditoría.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, paymentId]);

  const title = useMemo(() => (paymentId ? `Línea de vida · ${paymentId.slice(0, 8)}` : 'Línea de vida'), [paymentId]);

  if (!open || !paymentId) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white w-full max-w-2xl rounded-lg shadow-xl overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b bg-gray-50">
          <div>
            <div className="font-bold text-slate-800">{title}</div>
            <div className="text-xs text-gray-500">Eventos más nuevos arriba.</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm rounded border bg-white hover:bg-gray-50 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Actualizar
            </button>
            <button type="button" onClick={onClose} className="p-2 rounded hover:bg-gray-200">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="p-4">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <Loader2 className="w-4 h-4 animate-spin" /> Cargando auditoría...
            </div>
          )}
          {!loading && error && <div className="text-sm text-red-600">{error}</div>}

          {!loading && !error && items.length === 0 && <div className="text-sm text-gray-500">Sin eventos para mostrar.</div>}

          <div className="mt-3 space-y-3">
            {items.map((log) => {
              const { Icon, cls } = actionIcon(log.action);
              const stateChange = auditStateChange(log);

              return (
                <div key={log.id} className="border rounded-lg p-3">
                  <div className="flex items-start gap-3">
                    <Icon className={`w-5 h-5 mt-0.5 ${cls}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-800">{actionLabel(log.action)}</div>
                          <div className="text-[11px] text-gray-500 mt-0.5">
                            {(parseDbTimestamp(log.timestamp) ?? new Date(log.timestamp)).toLocaleString('es-PY', { timeZone: 'America/Asuncion' })} · {auditActor(log).name}
                          </div>
                        </div>
                      </div>

                      <div className="text-xs text-gray-700 mt-1">{describeAudit(log)}</div>
                      {stateChange && <div className="text-[11px] text-gray-500 mt-1">Estado: {stateChange}</div>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};


