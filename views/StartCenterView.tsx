import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle, Loader2, Play, RefreshCw, Server, Settings, XCircle } from 'lucide-react';
import { api, clearApiBaseURL, getApiBaseURL, isElectronApp, isNativeApp, setApiBaseURL } from '../services/api';
import {
  DB_READINESS_PATH,
  HealthState,
  ignoreFailure,
  parseDbReadinessError,
  parseDbReadinessPayload,
} from '../services/health-readiness';

const isAbsoluteHttpUrl = (value: string) => /^https?:\/\//i.test(value.trim());

export const StartCenterView = ({
  onBack,
}: {
  onBack?: () => void;
}) => {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState(getApiBaseURL());
  const [serverStatus, setServerStatus] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthState>({ status: 'unknown' });
  const [busy, setBusy] = useState<null | 'PROBE' | 'START_DB' | 'START_BACKEND' | 'START_ALL' | 'STOP_BACKEND' | 'STOP_DB'>(null);
  const [svc, setSvc] = useState<{
    backend?: { available: boolean; running: boolean; pid: number | null };
    ports?: { api3000?: { listening: boolean; pid: number | null }; db5433?: { listening: boolean; pid: number | null } };
    autoStart?: { enabled: boolean; running: boolean; done: boolean; ok: boolean | null; message: string };
  } | null>(null);
  const [lastOutput, setLastOutput] = useState<string | null>(null);

  const canUseLocalServices = isElectronApp && !!window.bankapi?.services;
  const showServerConfig = isNativeApp || isElectronApp;

  useEffect(() => {
    (async () => {
      try {
        if (!isElectronApp) return;
        if (!window.bankapi?.getAppVersion) return;
        const v = await window.bankapi.getAppVersion();
        if (v) setAppVersion(v);
      } catch {
        // ignore
      }
    })();
  }, []);

  const saveServerUrl = () => {
    setServerStatus(null);
    const next = serverUrl.trim();
    if (!isAbsoluteHttpUrl(next)) {
      setServerStatus('Usá una URL absoluta. Ej: http://IP_DEL_SERVIDOR:3000');
      return;
    }
    setApiBaseURL(next);
    setServerUrl(getApiBaseURL());
    setServerStatus('Servidor guardado.');
  };

  const restoreDefaultServerUrl = () => {
    clearApiBaseURL();
    setServerUrl(getApiBaseURL());
    setServerStatus('Servidor restaurado.');
  };

  const probe = useCallback(async () => {
    setBusy('PROBE');
    setLastOutput(null);
    try {
      const [healthRes, statusRes] = await Promise.all([
        api.get(DB_READINESS_PATH, { timeout: 5000 }),
        canUseLocalServices
          ? ignoreFailure(window.bankapi!.services!.status())
          : Promise.resolve(null),
      ]);
      setSvc(statusRes);
      setHealth(parseDbReadinessPayload(healthRes.data));
    } catch (e: any) {
      setHealth(parseDbReadinessError(e));
      if (canUseLocalServices) {
        try {
          const s = await window.bankapi!.services!.status();
          setSvc(s);
        } catch {
          // ignore
        }
      }
    } finally {
      setBusy(null);
    }
  }, [canUseLocalServices]);

  useEffect(() => {
    probe();
  }, [probe]);

  const statusBadge = useMemo(() => {
    if (health.status === 'unknown') return { text: 'Desconocido', cls: 'bg-gray-100 text-gray-700 border-gray-200', Icon: Loader2 };
    if (health.status === 'down') return { text: 'Sin conexión', cls: 'bg-red-100 text-red-700 border-red-200', Icon: XCircle };
    if (health.db === 'down') return { text: 'Backend OK · DB caída', cls: 'bg-amber-100 text-amber-800 border-amber-200', Icon: AlertCircle };
    return { text: 'Operativo', cls: 'bg-green-100 text-green-700 border-green-200', Icon: CheckCircle };
  }, [health]);

  const StatusIcon = statusBadge.Icon;

  const run = async (kind: typeof busy, fn: () => Promise<any>) => {
    setBusy(kind);
    setLastOutput(null);
    try {
      const res = await fn();
      const out = [res?.error, res?.stderr, res?.stdout].filter(Boolean).join('\n').trim();
      if (out) setLastOutput(out);
    } catch (e: any) {
      setLastOutput(String(e?.message || e));
    } finally {
      setBusy(null);
      await probe();
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 p-4 flex items-center justify-center">
      <div className="bg-white w-full max-w-2xl rounded-xl shadow-lg border p-6 space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-lg font-bold text-slate-800 flex items-center gap-2">
              <Server className="w-5 h-5 text-blue-600" /> Modo Inicio (Servidor / Diagnóstico)
            </div>
            <div className="text-xs text-slate-500 mt-1">
              Verifica conexión al backend y, si estás en la PC servidor, iniciá servicios con un click.
            </div>
          </div>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="px-3 py-2 text-sm rounded-lg border bg-white hover:bg-gray-50"
            >
              Volver
            </button>
          )}
        </div>
        {appVersion ? <div className="text-[11px] text-slate-500 -mt-3">App v{appVersion}</div> : null}

        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs ${statusBadge.cls}`}>
            <StatusIcon className={`w-4 h-4 ${health.status === 'unknown' ? 'animate-spin' : ''}`} />
            {statusBadge.text}
          </span>
          <button
            type="button"
            onClick={probe}
            disabled={busy !== null}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm rounded-lg border bg-white hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${busy === 'PROBE' ? 'animate-spin' : ''}`} />
            Probar conexión
          </button>
        </div>

        {showServerConfig && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                <Settings className="w-4 h-4" /> Backend (URL)
              </div>
              <div className="text-[11px] text-slate-500">
                Clientes en la red: usá <b>http://IP_DEL_SERVIDOR:3000</b>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <input
                type="text"
                className="flex-1 p-2 border rounded bg-white"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="http://IP_DEL_SERVIDOR:3000"
              />
              <button type="button" onClick={saveServerUrl} className="px-3 py-2 text-sm rounded border bg-white hover:bg-gray-50">
                Guardar
              </button>
              <button type="button" onClick={restoreDefaultServerUrl} className="px-3 py-2 text-sm rounded border bg-white hover:bg-gray-50">
                Restaurar
              </button>
            </div>
            {serverStatus && <div className="text-xs text-slate-600 mt-2">{serverStatus}</div>}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-lg border p-4">
            <div className="text-sm font-semibold text-slate-800">Estado backend</div>
            <div className="text-xs text-gray-600 mt-1">
              {health.status === 'ok' ? `OK (respuesta ${health.responseMs}ms)` : health.status === 'down' ? (health.error || 'Sin conexión') : '...'}
            </div>
            <div className="text-xs text-gray-500 mt-2">
              DB: <b>{health.status === 'ok' ? (health.db === 'ok' ? 'OK' : 'CAÍDA') : '--'}</b>
            </div>
          </div>

          <div className="rounded-lg border p-4">
            <div className="text-sm font-semibold text-slate-800">Servicios locales (esta PC)</div>
            {!canUseLocalServices ? (
              <div className="text-xs text-gray-500 mt-1">Disponible solo en la app de escritorio (Electron).</div>
            ) : (
              <div className="text-xs text-gray-600 mt-1">
                API :3000:{' '}
                <b>
                  {svc?.ports?.api3000?.listening ? `ESCUCHANDO (PID ${svc.ports.api3000.pid})` : 'NO'}
                </b>{' '}
                · DB :5433:{' '}
                <b>
                  {svc?.ports?.db5433?.listening ? `OK (PID ${svc.ports.db5433.pid})` : 'NO'}
                </b>
                {!svc?.backend?.available ? <span className="text-red-600"> · (backend no encontrado)</span> : null}
                {svc?.autoStart ? (
                  <span>
                    {' '}· Autoarranque:{' '}
                    <b>
                      {svc.autoStart.running
                        ? 'INICIANDO'
                        : svc.autoStart.done
                          ? svc.autoStart.ok ? 'OK' : 'FALLÓ'
                          : 'PENDIENTE'}
                    </b>
                  </span>
                ) : null}
              </div>
            )}
            {canUseLocalServices && svc?.autoStart?.message ? (
              <div className="text-[11px] text-gray-500 mt-1">{svc.autoStart.message}</div>
            ) : null}
          </div>
        </div>

        {canUseLocalServices && (
          <div className="rounded-lg border border-blue-100 bg-blue-50 p-4">
            <div className="text-sm font-semibold text-blue-900">Controles (Servidor)</div>
            <div className="text-[11px] text-blue-900/80 mt-1">Orden recomendado: DB → Backend.</div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => run('START_ALL', () => window.bankapi!.services!.startAll())}
                className="inline-flex items-center gap-2 px-3 py-2 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy === 'START_ALL' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                Iniciar todo
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => run('START_DB', () => window.bankapi!.services!.startDb())}
                className="px-3 py-2 text-sm rounded-lg border bg-white hover:bg-blue-100 disabled:opacity-50"
              >
                Iniciar DB (Docker)
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => run('START_BACKEND', () => window.bankapi!.services!.startBackend())}
                className="px-3 py-2 text-sm rounded-lg border bg-white hover:bg-blue-100 disabled:opacity-50"
              >
                Iniciar Backend
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => run('STOP_BACKEND', () => window.bankapi!.services!.stopBackend())}
                className="px-3 py-2 text-sm rounded-lg border bg-white hover:bg-blue-100 disabled:opacity-50"
              >
                Detener Backend
              </button>
            </div>
            {lastOutput && (
              <pre className="mt-3 text-[11px] bg-white border rounded p-2 overflow-auto max-h-48 whitespace-pre-wrap">
                {lastOutput}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
