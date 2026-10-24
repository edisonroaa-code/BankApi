import React, { useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { BankFeedStatus } from '../../types';
import { apiErrorMessage, requestBankRefresh } from '../../services/bankTransfers';
import { refreshRejectionMessage, refreshRemainingMs, serverClockOffsetMs } from '../../services/bank-refresh';

/**
 * "Actualizar" compartido: cualquiera que lo apriete pide una consulta al banco y el servidor la
 * hace una sola vez. Responde cuando el banco contestó; recién ahí esta pantalla relee la lista, así
 * lo nuevo aparece aunque el aviso en vivo no haya llegado. Las demás pantallas lo reciben por el
 * tiempo real. El servidor limita las consultas a una cada 5 s; durante esa espera el botón puede
 * releer lo ya registrado, sin quedar inutilizado por el ciclo automático continuo.
 */
export const BankRefreshButton = ({
  status,
  onStatus,
  onReload,
  showToast,
}: {
  status: BankFeedStatus | null;
  onStatus: (status: BankFeedStatus) => void;
  onReload: () => void | Promise<void>;
  showToast: (t: 'success' | 'error' | 'info', m: string) => void;
}) => {
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    setOffset(serverClockOffsetMs(status?.serverTime, Date.now()));
    setNow(Date.now());
  }, [status]);

  const remaining = refreshRemainingMs(status, now, offset);

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [remaining > 0]);

  const press = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Va al servidor aunque el tiempo real esté caído: la consulta al banco no depende de él.
      const result = await requestBankRefresh();
      onStatus(result.status);
      const message = refreshRejectionMessage(result.reason);
      if (message) showToast('info', message);
    } catch (e) {
      showToast('error', apiErrorMessage(e, 'No se pudo consultar al banco; se recargó la lista.'));
    } finally {
      try {
        await onReload();
      } finally {
        setBusy(false);
      }
    }
  };

  const seconds = Math.ceil(remaining / 1000);
  const lastPoll = status?.lastPollAt ? Date.parse(status.lastPollAt) : Number.NaN;
  const recentManual = !!status?.lastRefreshBy && Number.isFinite(lastPoll) && now + offset - lastPoll < 60_000;
  const who = recentManual ? (status!.lastRefreshBy as string).toUpperCase() : null;

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => void press()}
        disabled={busy}
        title={who ? `Última actualización pedida por ${who}` : remaining > 0 ? 'Actualizar la lista; la consulta al banco se comparte cada 5 segundos.' : 'Consultar al banco ahora (vale para todas las pantallas)'}
        aria-label="Actualizar"
        aria-busy={busy}
        className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg border bg-white text-xs font-semibold text-slate-600 hover:text-slate-900 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        <span className="hidden sm:inline">Actualizar</span>
        {remaining > 0 && <span className="tabular-nums text-slate-400">{seconds} s</span>}
      </button>
      {who && <span className="hidden md:inline text-[11px] text-slate-500">por {who}</span>}
    </div>
  );
};
