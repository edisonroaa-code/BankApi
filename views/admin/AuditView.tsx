import React, { useCallback, useEffect, useState } from "react";
import { Calendar, Filter, Loader2 } from "lucide-react";
import { api } from "../../services/api";
import { parseDbTimestamp } from "../../services/date";
import { AUDIT_ACTION_GROUPS, auditActionLabel, auditActor, auditStateChange, auditSubject, describeAudit } from "../../services/audit-format";
import { AuditLog } from "../../types";

export const AuditView = ({
  showToast,
}: {
  showToast: (t: "success" | "error" | "info", m: string) => void;
}) => {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [action, setAction] = useState("");
  const [actorUsername, setActorUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{ total: number; items: AuditLog[] }>({ total: 0, items: [] });


  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: any = { limit: 200 };
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;
      if (action) params.action = action;
      if (actorUsername) params.actorUsername = actorUsername;

      const res = await api.get("/payments/audit", { params });
      setData({ total: res.data.total || 0, items: res.data.items || [] });
    } catch (e) {
      showToast("error", "No se pudo cargar la auditoría.");
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, action, actorUsername, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="bg-white p-4 rounded-lg shadow-sm border flex flex-col md:flex-row md:items-end gap-4 justify-between">
        <div className="flex flex-wrap gap-4 items-end">
          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase mb-1 flex items-center gap-1">
              <Calendar className="w-3 h-3" /> Desde
            </label>
            <input type="date" className="p-2 border rounded text-sm" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase mb-1 flex items-center gap-1">
              <Calendar className="w-3 h-3" /> Hasta
            </label>
            <input type="date" className="p-2 border rounded text-sm" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase mb-1 flex items-center gap-1">
              <Filter className="w-3 h-3" /> Acción
            </label>
            <select className="p-2 border rounded text-sm min-w-[220px]" value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">Todas las acciones</option>
              {AUDIT_ACTION_GROUPS.map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.actions.map((code) => (
                    <option key={code} value={code}>
                      {auditActionLabel(code)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Usuario (opcional)</label>
            <input
              type="text"
              className="p-2 border rounded text-sm"
              placeholder="admin, supervisor, cobrador..."
              value={actorUsername}
              onChange={(e) => setActorUsername(e.target.value)}
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={load}
            disabled={loading}
            className="bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-slate-800 disabled:opacity-50 flex items-center gap-2"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Buscar
          </button>
          <div className="text-xs text-gray-500">
            Total: <b>{data.total}</b>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left min-w-[880px]">
            <thead className="bg-gray-50 text-gray-600 font-medium border-b">
              <tr>
                <th className="p-3">Fecha</th>
                <th className="p-3">Quién</th>
                <th className="p-3">Qué hizo</th>
                <th className="p-3">Sobre qué</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.items.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-8 text-center text-gray-400">
                    Sin registros.
                  </td>
                </tr>
              )}
              {data.items.map((log) => {
                const actor = auditActor(log);
                const subject = auditSubject(log);
                const stateChange = auditStateChange(log);
                return (
                  <tr key={log.id} className="hover:bg-gray-50 align-top">
                    <td className="p-3 text-xs text-gray-500 whitespace-nowrap">{(parseDbTimestamp(log.timestamp) ?? new Date(log.timestamp)).toLocaleString('es-PY', { timeZone: 'America/Asuncion' })}</td>
                    <td className="p-3 text-xs">
                      <div className="font-semibold text-slate-700">{actor.name}</div>
                      {actor.username && <div className="text-[10px] text-gray-400">{actor.username}</div>}
                    </td>
                    <td className="p-3 text-xs">
                      <div className="font-semibold text-slate-800">{auditActionLabel(log.action)}</div>
                      <div className="text-gray-600 mt-0.5">{describeAudit(log)}</div>
                      {stateChange && <div className="text-[11px] text-gray-500 mt-0.5">Estado: {stateChange}</div>}
                      {/* El código y los datos originales quedan a mano para una revisión técnica. */}
                      <details className="mt-1 text-[10px] text-gray-400">
                        <summary className="cursor-pointer select-none">Datos técnicos</summary>
                        <div className="font-mono break-all">{log.action}</div>
                        {log.metadata && <div className="font-mono break-all">{log.metadata}</div>}
                      </details>
                    </td>
                    <td className="p-3 text-xs">
                      {subject ? (
                        <>
                          <div className="font-semibold text-slate-700">{subject.main}</div>
                          {subject.detail && <div className="text-gray-500">{subject.detail}</div>}
                        </>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

