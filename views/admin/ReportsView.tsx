import React, { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { Payment, PaymentState, PaymentSummary } from "../../types";
import { StatusBadge } from "../../components/ui";
import { parseDbTimestamp } from "../../services/date";
import { api } from "../../services/api";

// Types for global libraries loaded via CDN
declare const XLSX: any;

export const ReportsView = ({
  payments,
  fetchSummary,
}: {
  payments: Payment[];
  fetchSummary: (range?: { startDate?: string; endDate?: string }) => Promise<PaymentSummary[]>;
}) => {
  const getCreatedAt = (value: string) => parseDbTimestamp(value) ?? new Date(value);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [serverSummary, setServerSummary] = useState<PaymentSummary[]>([]);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [summaryError, setSummaryError] = useState("");

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoadingSummary(true);
      setSummaryError("");
      try {
        const data = await fetchSummary({
          startDate: startDate || undefined,
          endDate: endDate || undefined,
        });
        if (active) setServerSummary(data);
      } catch (e) {
        if (active) {
          setSummaryError("No se pudo obtener el resumen validado.");
          setServerSummary([]);
        }
      } finally {
        if (active) setLoadingSummary(false);
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [startDate, endDate, fetchSummary]);

  const filteredPayments = payments.filter((p) => {
    if (!startDate && !endDate) return true;
    const pDate = getCreatedAt(p.createdAt);
    pDate.setHours(0, 0, 0, 0);

    const start = startDate ? new Date(startDate) : null;
    if (start) start.setHours(0, 0, 0, 0);

    const end = endDate ? new Date(endDate) : null;
    if (end) end.setHours(23, 59, 59, 999);

    if (start && pDate < start) return false;
    if (end && pDate > end) return false;
    return true;
  });

  const summaryConfirmed = serverSummary.filter(
    (s) => s.status === PaymentState.CONFIRMADO || s.status === PaymentState.CONFIRMADO_MANUAL,
  );
  const totalAmount = serverSummary.length
    ? serverSummary.reduce((acc, curr) => acc + curr.total, 0)
    : filteredPayments.reduce((acc, curr) => acc + curr.amount, 0);
  const confirmedCount = summaryConfirmed.length
    ? summaryConfirmed.reduce((acc, curr) => acc + curr.count, 0)
    : filteredPayments.filter((p) => p.status === PaymentState.CONFIRMADO || p.status === PaymentState.CONFIRMADO_MANUAL).length;
  const confirmedAmount = summaryConfirmed.length
    ? summaryConfirmed.reduce((acc, curr) => acc + curr.total, 0)
    : filteredPayments
      .filter((p) => p.status === PaymentState.CONFIRMADO || p.status === PaymentState.CONFIRMADO_MANUAL)
      .reduce((acc, curr) => acc + curr.amount, 0);
  const baseCount = serverSummary.length
    ? serverSummary.reduce((acc, curr) => acc + curr.count, 0)
    : filteredPayments.length;

  const handleExportExcel = () => {
    if (filteredPayments.length === 0) return;

    const data = filteredPayments.map((p) => ({
      Fecha: getCreatedAt(p.createdAt).toLocaleDateString('es-PY', { timeZone: 'America/Asuncion' }),
      Hora: getCreatedAt(p.createdAt).toLocaleTimeString('es-PY', { timeZone: 'America/Asuncion' }),
      "Código Cliente": p.clientCode,
      "Nombre Cliente": p.clientName || "N/A",
      Referencia: p.paymentRef,
      "Monto (PYG)": p.amount,
      Estado: p.status,
      // @ts-ignore
      Usuario: p.createdBy?.username || p.createdBy || "Unknown",
      "Motivo Rechazo/Manual": p.rejectionReason || p.observation || "",
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Auditoria_Pagos");
    XLSX.writeFile(wb, `Reporte_BankApi_${new Date().toISOString().split("T")[0]}.xlsx`);
  };

  const handleExportProfessionalExcel = async () => {
    try {
      const now = new Date();
      const month = startDate ? new Date(startDate).getMonth() : now.getMonth();
      const year = startDate ? new Date(startDate).getFullYear() : now.getFullYear();

      const response = await api.get(`/reports/export`, {
        params: { format: 'xlsx', month, year },
        responseType: 'blob',
      });

      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `Reporte_Profesional_${year}_${month + 1}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error exporting Excel:', error);
    }
  };

  const handleExportPdf = async () => {
    try {
      const now = new Date();
      const month = startDate ? new Date(startDate).getMonth() : now.getMonth();
      const year = startDate ? new Date(startDate).getFullYear() : now.getFullYear();

      const response = await api.get(`/reports/export`, {
        params: { format: 'pdf', month, year },
        responseType: 'blob',
      });

      const url = window.URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `Reporte_${year}_${month + 1}.pdf`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error exporting PDF:', error);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-4 rounded-lg shadow-sm border flex flex-col md:flex-row gap-4 items-end justify-between">
        <div className="flex flex-wrap gap-4 items-end">
          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Fecha Inicio</label>
            <input type="date" className="p-2 border rounded text-sm" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Fecha Fin</label>
            <input type="date" className="p-2 border rounded text-sm" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={handleExportExcel}
            disabled={filteredPayments.length === 0}
            className="bg-slate-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-slate-700 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download className="w-4 h-4" /> Excel (Local)
          </button>
          <button
            onClick={handleExportProfessionalExcel}
            className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 flex items-center gap-2"
          >
            <Download className="w-4 h-4" /> Excel Profesional
          </button>
          <button
            onClick={handleExportPdf}
            className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 flex items-center gap-2"
          >
            <Download className="w-4 h-4" /> PDF
          </button>
          <div className="text-[11px] text-slate-500">
            {loadingSummary ? "Validando totales..." : "Totales validados por backend"}
            {summaryError && <span className="text-red-500"> • {summaryError}</span>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white p-4 rounded-lg shadow-sm border border-blue-100">
          <p className="text-xs text-gray-500 uppercase font-bold">Total Ingresado (Declarado)</p>
          <p className="text-2xl font-bold text-blue-600">{new Intl.NumberFormat("es-PY", { style: "currency", currency: "PYG" }).format(totalAmount)}</p>
        </div>
        <div className="bg-white p-4 rounded-lg shadow-sm border border-green-100">
          <p className="text-xs text-gray-500 uppercase font-bold">Total Confirmado</p>
          <p className="text-2xl font-bold text-green-600">{new Intl.NumberFormat("es-PY", { style: "currency", currency: "PYG" }).format(confirmedAmount)}</p>
        </div>
        <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
          <p className="text-xs text-gray-500 uppercase font-bold">Efectividad</p>
          <p className="text-2xl font-bold text-gray-700">{baseCount > 0 ? Math.round((confirmedCount / baseCount) * 100) : 0}%</p>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm border overflow-hidden">
        <div className="p-4 border-b bg-gray-50 font-bold text-gray-700 flex justify-between items-center">
          <span>Detalle de Pagos (Auditoría)</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-100 text-gray-600 font-medium border-b">
              <tr>
                <th className="p-3">Fecha</th>
                <th className="p-3">Cod. Cliente</th>
                <th className="p-3">Ref. Pago</th>
                <th className="p-3">Monto</th>
                <th className="p-3">Estado</th>
                <th className="p-3">Usuario</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filteredPayments.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-gray-400">
                    No se encontraron pagos en este rango.
                  </td>
                </tr>
              )}
              {filteredPayments.map((p) => (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="p-3">{getCreatedAt(p.createdAt).toLocaleString('es-PY', { timeZone: 'America/Asuncion' })}</td>
                  <td className="p-3 font-mono text-xs">{p.clientCode || "-"}</td>
                  <td className="p-3 text-xs">{p.paymentRef || "-"}</td>
                  <td className="p-3 font-semibold">{new Intl.NumberFormat("es-PY", { style: "currency", currency: "PYG" }).format(p.amount)}</td>
                  <td className="p-3">
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="p-3 text-xs text-gray-500">{typeof p.createdBy === 'object' ? (p.createdBy as any)?.name : p.createdBy || "Admin"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
