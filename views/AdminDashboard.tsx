import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LayoutDashboard,
  Search,
  RefreshCw,
  Loader2,
  Users,
  FileText,
  Bell,
  Printer,
  CheckCircle,
  X,
  AlertCircle,
  Settings,
  BarChart3 as BarChartIcon
} from "lucide-react";
import { api } from "../services/api";
import { parseDbTimestamp } from "../services/date";
import { auditActionLabel, auditActor, describeAudit } from "../services/audit-format";
import { createRealtimeSocket, PaymentsRealtimeEvent } from "../services/realtime";
import { fetchPaymentDetail, fetchPaymentsPage, openPaymentTicket, upsertPayment } from "../services/payments";
import { onPaymentPrinted, onTicketIssued } from "../services/print-events";
import { canIssueTicket, paymentTicketIssued } from '../services/print-policy';
import { AuditLog, BankReceipt, BankTransfer, BankTransferStatus, Payment, PaymentState, PaymentSummary, User, UserRole } from "../types";
import { apiErrorMessage, fetchBankMatchesForPayment, fetchBankTransfer, newOperationKey, openReconciliationReceipt, reconcileBankTransfer } from "../services/bankTransfers";
import { assessManualApproval, canBeginManualApproval } from "../services/manual-approval-policy";
import { canUseApiFlow, canUseManualFlow, destinationLabel } from "../services/payment-destination";
import { isSupportedBankCurrency } from "../services/bank-claim-policy";
import { registerAndDisplayReceipt } from "../services/receipt-registration";
import { BankStatusBadge, MatchBadge, claimsSummary, formatDateTime as formatBankDateTime, formatMoney as formatBankMoney } from "../components/bank/bankUi";
import { CompactBarChart } from "../components/CompactBarChart";
import { StatusBadge } from "../components/ui";
import { ProofViewer } from "../components/ProofViewer";
import { ReportsView } from "./admin/ReportsView";
import { AuditView } from "./admin/AuditView";
import { UsersView } from "./admin/UsersView";
import { SystemConfigView } from "./admin/SystemConfigView";

// Respaldo por si el WebSocket esta bloqueado. Debe superar los 5 min de
// autosuspend de Neon: un poll mas corto deja el compute encendido toda la
// jornada y agota la cuota mensual sin trabajo real.
const FALLBACK_POLL_MS = 15 * 60 * 1000;

const AdminDashboard = ({ showToast, user, onPrintPayment, onPrintReceipt }: {
  showToast: (t: 'success' | 'error' | 'info', m: string) => void,
  user: User | null,
  onPrintPayment: (payment: Payment) => void,
  /** Comprobante de la transferencia conciliada, para que salga el ticket. */
  onPrintReceipt?: (receipt: BankReceipt) => void,
}) => {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentsPage, setPaymentsPage] = useState(1);
  const [paymentsTotalPages, setPaymentsTotalPages] = useState(1);
  const [paymentsTotal, setPaymentsTotal] = useState(0);
  const [summary, setSummary] = useState<PaymentSummary[]>([]);
  const [kpis, setKpis] = useState<any>(null);
  const [selectedPayment, setSelectedPayment] = useState<Payment | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  // Transferencias del banco con el mismo monto: conciliacion (admin) y alerta de doble uso.
  const [bankMatches, setBankMatches] = useState<BankTransfer[] | null>(null);
  const [bankMatchesError, setBankMatchesError] = useState<string | null>(null);
  const [isConfirmingManual, setIsConfirmingManual] = useState(false);
  const [isClassifyingDestination, setIsClassifyingDestination] = useState(false);
  const bankMatchRequestRef = useRef(0);
  const reviewSelectionRef = useRef<string | null>(null);
  const manualConfirmingRef = useRef(false);
  const [reconcilingId, setReconcilingId] = useState<string | null>(null);
  const [view, setView] = useState<'LIST' | 'REPORTS' | 'USERS' | 'AUDIT' | 'CONFIG'>('LIST');
  const [listMode, setListMode] = useState<'QUEUE' | 'ALL'>('QUEUE');
  const [reason, setReason] = useState('');
  const [isOpeningReview, setIsOpeningReview] = useState(false);
  const [pendingPrints, setPendingPrints] = useState<Array<{ transferId: string; paymentId: string; label: string }>>([]);
  const [retryingPrintId, setRetryingPrintId] = useState<string | null>(null);

  const manualRisk = selectedPayment && bankMatches ? assessManualApproval(selectedPayment, bankMatches) : null;
  const manualApprovalReady = !!selectedPayment && canBeginManualApproval(selectedPayment, bankMatches, bankMatchesError);

  const OVERDUE_MINUTES = 10;

  const parseCreatedAt = useCallback((value?: string | null) => {
    return parseDbTimestamp(value) ?? (value ? new Date(value) : null);
  }, []);

  const formatPyDateTime = useCallback((value?: string | null) => {
    const dt = parseCreatedAt(value);
    return dt ? dt.toLocaleString('es-PY', { timeZone: 'America/Asuncion' }) : '--';
  }, [parseCreatedAt]);

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
  const [reportMonth, setReportMonth] = useState(() => new Date().getMonth()); // 0-11

  const reportRange = useMemo(() => {
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const startDate = `${reportYear}-${pad2(reportMonth + 1)}-01`;
    const endDate = `${reportYear}-${pad2(reportMonth + 1)}-${pad2(new Date(reportYear, reportMonth + 1, 0).getDate())}`;
    return { startDate, endDate };
  }, [reportMonth, reportYear]);

  const isClaimActive = useCallback((p: Payment) => {
    if (!p.reviewClaimedById || !p.reviewClaimExpiresAt) return false;
    const exp = (parseDbTimestamp(p.reviewClaimExpiresAt) ?? new Date(p.reviewClaimExpiresAt)).getTime();
    return Number.isFinite(exp) && exp > Date.now();
  }, []);

  const isClaimMine = useCallback((p: Payment) => {
    if (!user?.id) return false;
    return isClaimActive(p) && p.reviewClaimedById === user.id;
  }, [isClaimActive, user?.id]);

  const getCollectorName = useCallback((p: Payment) => {
    const createdBy: any = (p as any).createdBy;
    if (createdBy && typeof createdBy === 'object') return createdBy.name || createdBy.username || createdBy.id || 'Cobrador';
    return (p as any).createdById || (typeof createdBy === 'string' ? createdBy : 'Cobrador');
  }, []);

  const canActOnPayment = useCallback((p: Payment) => {
    if (p.status === PaymentState.CONFIRMADO || p.status === PaymentState.CONFIRMADO_MANUAL || p.status === PaymentState.RECHAZADO) return false;
    if (!isClaimActive(p)) return true;
    if (!user?.id) return false;
    return p.reviewClaimedById === user.id;
  }, [isClaimActive, user?.id]);

  const fetchSummary = useCallback(async (range?: { startDate?: string, endDate?: string }) => {
    const params: Record<string, string> = {};
    if (range?.startDate) params.startDate = range.startDate;
    if (range?.endDate) params.endDate = range.endDate;
    const res = await api.get('/payments/summary', { params });
    return res.data as PaymentSummary[];
  }, []);

  const loadPayments = useCallback(async (page = 1, mode = listMode) => {
    try {
      const data = await fetchPaymentsPage({
        page,
        pageSize: 50,
        statuses: mode === 'QUEUE'
          ? [PaymentState.PENDIENTE_VERIFICACION, PaymentState.EN_REVISION]
          : undefined,
      });
      setPayments(data.items);
      setPaymentsPage(data.page);
      setPaymentsTotalPages(data.totalPages);
      setPaymentsTotal(data.total);
    } catch (e) { }
  }, [listMode]);

  const loadSummaryAndKpis = useCallback(async () => {
    try {
      const [resSummary, resKpis] = await Promise.all([
        fetchSummary(reportRange),
        api.get('/payments/kpis', { params: { overdueMinutes: OVERDUE_MINUTES, ...reportRange } }),
      ]);
      setSummary(resSummary);
      setKpis(resKpis.data);
    } catch (e) { }
  }, [fetchSummary, reportRange]);

  const refreshData = useCallback(async () => {
    await loadPayments(paymentsPage, listMode);
    void loadSummaryAndKpis();
  }, [listMode, loadPayments, loadSummaryAndKpis, paymentsPage]);

  useEffect(() => {
    loadPayments(paymentsPage, listMode);
    void loadSummaryAndKpis();

    const socket = createRealtimeSocket();
    socket.on('payments:changed', (evt: PaymentsRealtimeEvent) => {
      const shouldNotify = user?.role !== UserRole.COBRADOR && evt?.type === 'PAYMENT_CREATED';
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
        loadPayments(paymentsPage, listMode);
        void loadSummaryAndKpis();
        return;
      }
      fetchPaymentDetail(evt.paymentId)
        .then((payment) => {
          const belongsInQueue =
            payment.status === PaymentState.PENDIENTE_VERIFICACION ||
            payment.status === PaymentState.EN_REVISION;
          setPayments((prev) => {
            if (listMode === 'QUEUE' && !belongsInQueue) {
              return prev.filter((item) => item.id !== payment.id);
            }
            return upsertPayment(prev, payment).slice(0, 50);
          });
          // El detalle abierto también: si no, tras imprimir seguía sin "Marcar Pago en Caja".
          if (reviewSelectionRef.current === payment.id) setSelectedPayment(payment);
          void loadSummaryAndKpis();
        })
        .catch(() => { });
    });

    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      loadPayments(paymentsPage, listMode);
    }, FALLBACK_POLL_MS);

    return () => {
      clearInterval(interval);
      socket.disconnect();
    };
  }, [listMode, loadPayments, loadSummaryAndKpis, paymentsPage, user?.role]);

  // Confirmado "Sí, salió impreso" en esta app: lista y detalle se actualizan sin esperar al socket.
  useEffect(() => onPaymentPrinted((printed) => {
    setPayments((prev) => (prev.some((p) => p.id === printed.id) ? upsertPayment(prev, printed) : prev));
    if (reviewSelectionRef.current === printed.id) setSelectedPayment(printed);
  }), []);

  const loadBankMatches = async (paymentId: string): Promise<BankTransfer[] | null> => {
    const requestId = ++bankMatchRequestRef.current;
    setBankMatches(null);
    setBankMatchesError(null);
    try {
      const matches = await fetchBankMatchesForPayment(paymentId);
      if (requestId === bankMatchRequestRef.current) setBankMatches(matches);
      return matches;
    } catch (error) {
      if (requestId === bankMatchRequestRef.current) {
        setBankMatchesError(apiErrorMessage(error, 'No se pudieron verificar las transferencias del banco.'));
      }
      return null;
    }
  };

  const closeReview = () => {
    reviewSelectionRef.current = null;
    bankMatchRequestRef.current += 1;
    setBankMatches(null);
    setBankMatchesError(null);
    setSelectedPayment(null);
  };

  const openReview = async (p: Payment) => {
    // Abrir al instante con el dato liviano de la cola. El detalle, la toma
    // exclusiva y la auditoría se completan sin bloquear la interacción.
    reviewSelectionRef.current = p.id;
    setSelectedPayment(p);
    setReason('');
    setAuditLogs([]);
    setAuditLoading(true);
    setIsOpeningReview(true);

    if (p.status === PaymentState.PENDIENTE_VERIFICACION || p.status === PaymentState.EN_REVISION) {
      void loadBankMatches(p.id);
    } else {
      bankMatchRequestRef.current += 1;
      setBankMatches([]);
      setBankMatchesError(null);
    }

    void api
      .get(`/payments/${p.id}/audit`)
      .then(({ data }) => {
        if (reviewSelectionRef.current === p.id) setAuditLogs(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (reviewSelectionRef.current === p.id) setAuditLogs([]);
      })
      .finally(() => {
        if (reviewSelectionRef.current === p.id) setAuditLoading(false);
      });

    let nextPayment = p;
    try {
      if (p.status !== PaymentState.CONFIRMADO && p.status !== PaymentState.CONFIRMADO_MANUAL && p.status !== PaymentState.RECHAZADO) {
        const claimed = await api.post(`/payments/${p.id}/claim-review`);
        nextPayment = claimed.data;
        setPayments((prev) => prev.map((x) => x.id === nextPayment.id ? nextPayment : x));
      } else {
        nextPayment = await fetchPaymentDetail(p.id);
      }
      setSelectedPayment((current) => current?.id === p.id ? nextPayment : current);
    } catch (e: any) {
      const msg = e?.response?.data?.message;
      if (msg && reviewSelectionRef.current === p.id) showToast('info', String(msg));
    } finally {
      if (reviewSelectionRef.current === p.id) setIsOpeningReview(false);
    }
  };

  const handleReleaseReview = async (p: Payment) => {
    try {
      const { data } = await api.post(`/payments/${p.id}/release-review`);
      setPayments((prev) => prev.map((x) => x.id === data.id ? data : x));
      if (selectedPayment?.id === data.id) setSelectedPayment(data);
      showToast('success', 'Caso liberado.');
    } catch (e: any) {
      const msg = e?.response?.data?.message;
      showToast('error', msg ? String(msg) : 'No se pudo liberar el caso.');
    }
  };

  const handleReconcile = async (transfer: BankTransfer) => {
    if (!selectedPayment) return;
    if (!canUseApiFlow(selectedPayment.isAtlasAccount)) {
      showToast('info', 'Solo las consultas clasificadas como cuenta Atlas pueden conciliarse con este movimiento bancario.');
      return;
    }
    if (!canActOnPayment(selectedPayment)) {
      showToast('info', 'Este caso está tomado por otro gerente o ya fue resuelto.');
      return;
    }
    const when = formatBankDateTime(transfer.movementAt);
    if (!window.confirm(`¿Conciliar esta consulta con la transferencia de ${transfer.senderName || 'remitente no informado'} (${when})? Quedará aprobada y la transferencia bloqueada para cualquier otro uso.`)) return;
    setReconcilingId(transfer.id);
    try {
      const conciliated = await reconcileBankTransfer(transfer.id, selectedPayment.id, newOperationKey());
      const updated = await fetchPaymentDetail(selectedPayment.id);
      setPayments((prev) => upsertPayment(prev, updated));
      showToast('success', 'Consulta conciliada con la transferencia del banco y aprobada.');
      // El comprobante solo se abre si el backend registró su impresión.
      if (onPrintReceipt) {
        try {
          await registerAndDisplayReceipt(() => openReconciliationReceipt(conciliated, selectedPayment.id), onPrintReceipt);
        } catch (error) {
          setPendingPrints((prev) => [...prev.filter((item) => item.paymentId !== selectedPayment.id || item.transferId !== transfer.id), {
            transferId: transfer.id,
            paymentId: selectedPayment.id,
            label: selectedPayment.paymentRef || selectedPayment.clientName || selectedPayment.id.slice(0, 8),
          }]);
          showToast('error', `Conciliación guardada, pero no se pudo abrir el comprobante: ${apiErrorMessage(error, 'reintentá aquí o desde Transferencias recibidas')}.`);
        }
      }
      if (reviewSelectionRef.current === selectedPayment.id) closeReview();
      void loadSummaryAndKpis();
    } catch (e) {
      showToast('error', apiErrorMessage(e, 'No se pudo conciliar.'));
      void loadBankMatches(selectedPayment.id);
    } finally {
      setReconcilingId(null);
    }
  };

  const handleManualConfirm = async () => {
    const payment = selectedPayment;
    if (!payment || manualConfirmingRef.current) return;
    if (!canActOnPayment(payment)) {
      showToast('info', 'Este caso está tomado por otro gerente o ya fue resuelto.');
      return;
    }
    if (!canUseManualFlow(payment.isAtlasAccount)) {
      showToast('info', payment.isAtlasAccount === true
        ? 'Cuenta Atlas: aprobá únicamente mediante toma o conciliación de un movimiento visible en la API.'
        : 'Elegí si esta consulta anterior se depositó en Atlas o en BNF antes de aprobarla.');
      return;
    }
    if (!bankMatches || bankMatchesError) {
      showToast('info', 'Esperá a que se verifiquen las transferencias del banco antes de aprobar.');
      return;
    }
    if (!canBeginManualApproval(payment, bankMatches, bankMatchesError)) return;
    manualConfirmingRef.current = true;
    setIsConfirmingManual(true);
    try {
      // El listado de la pantalla puede haber cambiado: se verifica otra vez antes de confirmar.
      const currentMatches = await loadBankMatches(payment.id);
      if (reviewSelectionRef.current !== payment.id) return;
      if (!currentMatches) {
        showToast('error', 'No se pudieron verificar las transferencias del banco. Reintentá la consulta.');
        return;
      }
      const risk = assessManualApproval(payment, currentMatches);
      if (risk.partialBankAllocation) {
        showToast('error', 'Esta consulta ya tiene una conciliación bancaria parcial. Completá o revisá esa conciliación.');
        return;
      }
      if (risk.blockingMatches.length > 0) {
        showToast('error', 'Hay una transferencia vinculada por referencia o concepto. Resolvé la conciliación bancaria antes de aprobar manualmente.');
        return;
      }
      const trimmed = reason.trim();
      if (risk.claimedNonBlockingMatches.length > 0 && !trimmed) {
        showToast('info', 'Hay una transferencia tomada con datos del mismo cliente. Revisá la evidencia e indicá por qué corresponde a otro ingreso.');
        return;
      }
      if (risk.claimedNonBlockingMatches.length > 0) {
        if (!window.confirm(
          `Hay ${risk.claimedNonBlockingMatches.length === 1 ? 'una transferencia tomada' : `${risk.claimedNonBlockingMatches.length} transferencias tomadas`} con datos del mismo cliente (${risk.claimedNonBlockingMatches
            .map((transfer) => `${claimsSummary(transfer)}: ${transfer.match?.reason ?? ''}`)
            .join('; ')}). Confirmá solo si revisaste que este comprobante corresponde a otro ingreso.`,
        )) return;
      }
      const payload: any = {};
      if (trimmed) payload.reason = trimmed;
      const { data } = await api.post(`/payments/${payment.id}/confirm-manual`, payload);
      setPayments((prev) => upsertPayment(prev, data));
      showToast('success', 'Ingreso aprobado.');
      if (reviewSelectionRef.current === payment.id) closeReview();
      void loadSummaryAndKpis();
    } catch (e: any) {
      showToast('error', apiErrorMessage(e, 'Error al confirmar.'));
      if (e?.response?.status === 409 && reviewSelectionRef.current === payment.id) {
        void loadBankMatches(payment.id);
        void fetchPaymentDetail(payment.id).then((updated) => {
          setSelectedPayment((current) => current?.id === payment.id ? updated : current);
          setPayments((prev) => upsertPayment(prev, updated));
        }).catch(() => undefined);
      }
    } finally {
      manualConfirmingRef.current = false;
      setIsConfirmingManual(false);
    }
  };

  const handleClassifyDestination = async (isAtlasAccount: boolean) => {
    const payment = selectedPayment;
    if (!payment || payment.isAtlasAccount != null || !canActOnPayment(payment) || isClassifyingDestination) return;
    const target = isAtlasAccount ? 'Atlas (solo se aprueba conciliando con el banco)' : 'BNF (aprobación manual)';
    if (!window.confirm(`¿Confirmás que esta consulta se depositó en ${target}? Verificalo en el comprobante antes de registrarlo.`)) return;
    setIsClassifyingDestination(true);
    try {
      const { data } = await api.patch(`/payments/${payment.id}`, { isAtlasAccount });
      setPayments((prev) => upsertPayment(prev, data));
      if (reviewSelectionRef.current === payment.id) {
        setSelectedPayment(data);
        void loadBankMatches(payment.id);
      }
      showToast('success', `Banco de depósito registrado: ${target}.`);
    } catch (error) {
      showToast('error', apiErrorMessage(error, 'No se pudo registrar el banco de depósito.'));
    } finally {
      setIsClassifyingDestination(false);
    }
  };

  const retryPendingPrint = async (item: { transferId: string; paymentId: string }) => {
    if (!onPrintReceipt) return;
    setRetryingPrintId(item.paymentId);
    try {
      const current = await fetchBankTransfer(item.transferId);
      await registerAndDisplayReceipt(() => openReconciliationReceipt(current, item.paymentId), onPrintReceipt);
      setPendingPrints((prev) => prev.filter((pending) => pending.paymentId !== item.paymentId || pending.transferId !== item.transferId));
    } catch (error) {
      showToast('error', apiErrorMessage(error, 'No se pudo abrir el comprobante. La conciliación sigue guardada.'));
    } finally {
      setRetryingPrintId(null);
    }
  };

  const handleReject = async () => {
    if (!selectedPayment) return;
    if (!canActOnPayment(selectedPayment)) {
      showToast('info', 'Este caso está tomado por otro gerente o ya fue resuelto.');
      return;
    }
    if (window.confirm("¿Está seguro que desea marcar como 'No ingreso'?")) {
      try {
        const payload: any = {};
        const trimmed = reason.trim();
        if (trimmed) payload.reason = trimmed;
        const { data } = await api.post(`/payments/${selectedPayment.id}/reject`, payload);
        setPayments((prev) => upsertPayment(prev, data));
        showToast('success', 'Marcado como no ingreso.');
        if (reviewSelectionRef.current === selectedPayment.id) closeReview();
        void loadSummaryAndKpis();
      } catch (e: any) {
        const msg = e?.response?.data?.message;
        showToast('error', msg ? String(msg) : 'Error al rechazar.');
      }
    }
  };

  const handleUndoDecision = async () => {
    if (!selectedPayment) return;
    if (selectedPayment.cashPaidAt || selectedPayment.printedAt) {
      showToast('info', 'No se puede anular: el pago ya pasó por ticket o caja.');
      return;
    }
    if (!window.confirm('¿Anular la decisión y volver a estado Pendiente?')) return;
    try {
      const { data } = await api.post(`/payments/${selectedPayment.id}/undo-decision`);
      setSelectedPayment(data);
      setPayments((prev) => prev.map((x) => (x.id === data.id ? data : x)));
      showToast('success', 'Decisión anulada.');
      refreshData();
    } catch (e: any) {
      const msg = e?.response?.data?.message;
      showToast('error', msg ? String(msg) : 'No se pudo anular la decisión.');
    }
  };

  const handleCashPaid = async () => {
    if (!selectedPayment) return;
    try {
      const { data } = await api.post(`/payments/${selectedPayment.id}/cash-paid`);
      setSelectedPayment(data);
      setPayments((prev) => prev.map((x) => x.id === data.id ? data : x));
      showToast('success', 'Marcado como pago en caja.');
      refreshData();
    } catch (e: any) {
      const msg = e?.response?.data?.message;
      showToast('error', msg ? String(msg) : 'No se pudo marcar caja.');
    }
  };

  const handlePrintTicket = async () => {
    if (!selectedPayment) return;
    const previouslyPrinted = !!selectedPayment.printedAt;

    try {
      // Se cuenta como impreso recién cuando se confirma que salió (al cerrar el diálogo).
      const data = await openPaymentTicket(selectedPayment.id);
      onPrintPayment({ ...data, reprint: previouslyPrinted });
    } catch (e: any) {
      const msg = e?.response?.data?.message;
      showToast('error', msg ? String(msg) : 'No se pudo abrir el ticket; reintentá desde este caso.');
    }
  };

  const summaryCount = (state: PaymentState) => {
    const hit = summary.find(s => s.status === state);
    if (hit) return hit.count;
    return payments.filter(p => p.status === state).length;
  };

  const summaryTotal = (state: PaymentState) => {
    const hit = summary.find(s => s.status === state);
    if (hit) return hit.total;
    return payments.filter(p => p.status === state).reduce((acc, curr) => acc + curr.amount, 0);
  };

  // Stats
  const monthStats = {
    consulted: summary.length ? summary.reduce((acc, curr) => acc + curr.count, 0) : payments.length,
    confirmed: summaryCount(PaymentState.CONFIRMADO) + summaryCount(PaymentState.CONFIRMADO_MANUAL),
    rejected: summaryCount(PaymentState.RECHAZADO),
  };

  const totalsValidated = {
    declared: summary.length ? summary.reduce((acc, curr) => acc + curr.total, 0) : payments.reduce((acc, curr) => acc + curr.amount, 0),
    confirmed: summaryTotal(PaymentState.CONFIRMADO) + summaryTotal(PaymentState.CONFIRMADO_MANUAL),
  };

  const queuePayments = payments.filter(p => p.status === PaymentState.PENDIENTE_VERIFICACION || p.status === PaymentState.EN_REVISION);
  const queueStats = {
    pendingNow: queuePayments.filter((p) => p.status === PaymentState.PENDIENTE_VERIFICACION).length,
    reviewNow: queuePayments.filter((p) => p.status === PaymentState.EN_REVISION).length,
  };

  const listPayments = (() => {
    if (view !== 'LIST') return payments;
    if (listMode === 'ALL') return payments;
    return [...queuePayments].sort((a, b) => {
      const aMine = isClaimMine(a) ? 1 : 0;
      const bMine = isClaimMine(b) ? 1 : 0;
      if (aMine !== bMine) return bMine - aMine;

      const aClaimed = isClaimActive(a) ? 1 : 0;
      const bClaimed = isClaimActive(b) ? 1 : 0;
      if (aClaimed !== bClaimed) return aClaimed - bClaimed; // unclaimed first after "mine"

      const aAge = (parseCreatedAt(a.createdAt)?.getTime() || 0);
      const bAge = (parseCreatedAt(b.createdAt)?.getTime() || 0);
      return aAge - bAge; // oldest first
    });
  })();

  return (
    <div className="space-y-6">
      {/* 1. Main Navigation Header */}
      <div className="flex flex-col items-stretch gap-3 pb-2 border-b sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <h2 className="text-xl font-bold text-slate-800">Panel de Administración</h2>
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0">
          {view === 'LIST' && (
            <div className="shrink-0 bg-slate-100 p-1 rounded-lg flex gap-1">
              <button
                onClick={() => setListMode('QUEUE')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition ${listMode === 'QUEUE' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                Pendientes ({queueStats.pendingNow + queueStats.reviewNow})
              </button>
              <button
                onClick={() => setListMode('ALL')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition ${listMode === 'ALL' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                Todos
              </button>
            </div>
          )}
          <div className="h-8 w-[1px] bg-slate-200 mx-1 hidden md:block"></div>
          <button
            onClick={() => setView('LIST')}
            className={`shrink-0 px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2 ${view === 'LIST' ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 border'}`}
          >
            <LayoutDashboard className="w-4 h-4" /> Bandeja
          </button>
          <button
            onClick={() => setView('REPORTS')}
            className={`shrink-0 px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2 ${view === 'REPORTS' ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 border'}`}
          >
            <FileText className="w-4 h-4" /> Reportes
          </button>
          <button
            onClick={() => setView('USERS')}
            className={`shrink-0 px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2 ${view === 'USERS' ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 border'}`}
          >
            <Users className="w-4 h-4" /> Usuarios
          </button>
          <button
            onClick={() => setView('AUDIT')}
            className={`shrink-0 px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2 ${view === 'AUDIT' ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 border'}`}
          >
            <Bell className="w-4 h-4" /> Auditoria
          </button>
          <button
            onClick={() => setView('CONFIG')}
            className={`shrink-0 px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2 ${view === 'CONFIG' ? 'bg-emerald-700 text-white' : 'bg-white text-slate-600 border'}`}
          >
            <Settings className="w-4 h-4" /> Configuración
          </button>
        </div>
      </div>

      {pendingPrints.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="alert">
          <p className="font-bold">Conciliación guardada; el comprobante no se pudo abrir.</p>
          <p className="mt-1">No entregues nada hasta imprimirlo. También podés imprimirlo desde Transferencias recibidas.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {pendingPrints.map((item) => (
              <button key={`${item.transferId}:${item.paymentId}`} type="button" onClick={() => void retryPendingPrint(item)} disabled={retryingPrintId !== null} className="rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">
                {retryingPrintId === item.paymentId ? 'Abriendo…' : `Imprimir · ${item.label}`}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 2. Main View Content */}
      <div className="min-h-[300px]">
        {view === 'LIST' && (
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="bg-white rounded-lg shadow-sm border overflow-hidden">
              {/* Mobile cards */}
              <div className="sm:hidden divide-y">
                {listPayments.map((p) => (
                  <div key={p.id} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-800">
                          {new Intl.NumberFormat('es-PY', { style: 'currency', currency: 'PYG' }).format(p.amount)}
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          {p.clientCode ? <span className="font-mono">{p.clientCode}</span> : '-'}
                          {p.paymentRef ? <span> · Ref: {p.paymentRef}</span> : null}
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          Cobrador: <b>{getCollectorName(p)}</b>
                        </div>
                        <div className="text-xs text-slate-600 mt-1">Destino: {destinationLabel(p.isAtlasAccount)}</div>
                        <div className="text-[11px] text-gray-400 mt-1">{formatPyDateTime(p.createdAt)}</div>
                      </div>
                      <div className="shrink-0 flex flex-col items-end gap-2">
                        <StatusBadge status={p.status} />
                        {isClaimActive(p) && (
                          <div className="text-[11px] text-gray-500 text-right max-w-[180px]">
                            Tomado por: <b>{p.reviewClaimedByName || p.reviewClaimedByUsername || p.reviewClaimedById}</b>
                          </div>
                        )}
                        <button
                          onClick={() => openReview(p)}
                          className="text-blue-600 font-semibold text-xs px-3 py-1 border border-blue-200 rounded hover:bg-blue-50"
                        >
                          Revisar
                        </button>
                        {isClaimMine(p) && (
                          <button
                            onClick={() => handleReleaseReview(p)}
                            className="text-gray-700 font-semibold text-xs px-3 py-1 border border-gray-200 rounded hover:bg-gray-50"
                          >
                            Soltar
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                {listPayments.length === 0 && <div className="p-8 text-center text-gray-400">Sin pagos.</div>}
              </div>

              {/* Desktop/tablet table */}
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-sm text-left min-w-[720px]">
                  <thead className="bg-gray-50 text-gray-600 font-medium border-b">
                    <tr>
                      <th className="p-3">Monto</th>
                      <th className="p-3">Cliente</th>
                      <th className="p-3">Fecha</th>
                      <th className="p-3">Estado</th>
                      <th className="p-3 text-right">Acción</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {listPayments.map((p) => (
                      <tr key={p.id} className="hover:bg-gray-50">
                        <td className="p-3 font-semibold">
                          {new Intl.NumberFormat('es-PY', { style: 'currency', currency: 'PYG' }).format(p.amount)}
                        </td>
                        <td className="p-3 text-gray-600">
                          <div>{p.clientName || '-'}</div>
                          {p.clientCode && <div className="text-xs text-gray-400">Code: {p.clientCode}</div>}
                          <div className="text-xs text-gray-400">Cobrador: {getCollectorName(p)}</div>
                          <div className="text-xs text-slate-600">Destino: {destinationLabel(p.isAtlasAccount)}</div>
                        </td>
                        <td className="p-3 text-gray-500 text-xs">{formatPyDateTime(p.createdAt)}</td>
                        <td className="p-3">
                          <StatusBadge status={p.status} />
                        </td>
                        <td className="p-3 text-right">
                          <button
                            onClick={() => openReview(p)}
                            className="text-blue-600 hover:text-blue-800 font-medium text-xs px-3 py-1 border border-blue-200 rounded hover:bg-blue-50"
                          >
                            Revisar
                          </button>
                          {isClaimMine(p) && (
                            <button
                              onClick={() => handleReleaseReview(p)}
                              className="ml-2 text-gray-700 hover:text-gray-900 font-medium text-xs px-3 py-1 border border-gray-200 rounded hover:bg-gray-50"
                            >
                              Soltar
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between gap-3 p-3 border-t bg-slate-50">
                <span className="text-xs text-gray-500">
                  Página {paymentsPage} de {paymentsTotalPages} · {paymentsTotal} registros
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={paymentsPage <= 1}
                    onClick={() => loadPayments(paymentsPage - 1, listMode)}
                    className="px-3 py-1.5 text-xs rounded border bg-white disabled:opacity-40"
                  >
                    Anterior
                  </button>
                  <button
                    type="button"
                    disabled={paymentsPage >= paymentsTotalPages}
                    onClick={() => loadPayments(paymentsPage + 1, listMode)}
                    className="px-3 py-1.5 text-xs rounded border bg-white disabled:opacity-40"
                  >
                    Siguiente
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {view === 'USERS' && user && <UsersView showToast={showToast} currentUser={user} />}
        {view === 'AUDIT' && <AuditView showToast={showToast} />}
        {view === 'REPORTS' && <ReportsView payments={payments} fetchSummary={fetchSummary} />}
        {view === 'CONFIG' && <SystemConfigView showToast={showToast} />}
      </div>


      {/* 3. Live Stats Bar (Minicards) - Contextual for LIST view */}
      {view === 'LIST' && kpis && (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 animate-in fade-in duration-500">
          <div className="bg-white p-3 rounded-lg border shadow-sm flex items-center gap-3">
            <div className="p-2 bg-slate-50 rounded text-slate-500"><Search className="w-4 h-4" /></div>
            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase">Pendientes</p>
              <p className="text-lg font-bold text-slate-700">{kpis?.now?.pending ?? 0}</p>
            </div>
          </div>
          <div className="bg-white p-3 rounded-lg border shadow-sm flex items-center gap-3">
            <div className="p-2 bg-amber-50 rounded text-amber-500"><AlertCircle className="w-4 h-4" /></div>
            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase">En Revisión</p>
              <p className="text-lg font-bold text-amber-600">{kpis?.now?.claimed ?? 0}</p>
            </div>
          </div>
          <div className="bg-white p-3 rounded-lg border shadow-sm flex items-center gap-3">
            <div className="p-2 bg-blue-50 rounded text-blue-500"><CheckCircle className="w-4 h-4" /></div>
            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase">Resueltos Mes</p>
              <p className="text-lg font-bold text-blue-700">{kpis?.period?.decisions ?? 0}</p>
            </div>
          </div>
        </div>
      )}

      {/* 4. Monthly Stats & Historical Performance (Lower Priority) */}
      <div className="space-y-6 pt-6 border-t mt-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-500 uppercase flex items-center gap-2">
            <BarChartIcon className="w-4 h-4" /> Histórico y Rendimiento
          </h3>
          <div className="flex gap-2 items-center text-xs">
            <select className="border-none bg-white font-semibold rounded cursor-pointer" value={reportMonth} onChange={(e) => setReportMonth(Number(e.target.value))}>
              {monthNames.map((m, idx) => <option key={m} value={idx}>{m}</option>)}
            </select>
            <select className="border-none bg-white font-semibold rounded cursor-pointer" value={reportYear} onChange={(e) => setReportYear(Number(e.target.value))}>
              {[0, 1, 2].map(i => <option key={i} value={new Date().getFullYear() - i}>{new Date().getFullYear() - i}</option>)}
            </select>
            <button onClick={refreshData} className="p-1 hover:bg-gray-100 rounded text-slate-400 transition-colors"><RefreshCw className="w-3 h-3" /></button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-slate-50 p-4 rounded-lg border">
            <p className="text-[10px] font-bold text-slate-400 uppercase">Total Ingresos ({monthNames[reportMonth]})</p>
            <p className="text-xl font-bold text-green-600">{new Intl.NumberFormat('es-PY', { style: 'currency', currency: 'PYG' }).format(totalsValidated.confirmed)}</p>
          </div>
          <div className="bg-slate-50 p-4 rounded-lg border">
            <p className="text-[10px] font-bold text-slate-400 uppercase">No Ingresos</p>
            <p className="text-xl font-bold text-red-500">{new Intl.NumberFormat('es-PY', { style: 'currency', currency: 'PYG' }).format(totalsValidated.declared - totalsValidated.confirmed)}</p>
          </div>
          <div className="bg-slate-50 p-4 rounded-lg border">
            <p className="text-[10px] font-bold text-slate-400 uppercase">Total Declarado</p>
            <p className="text-xl font-bold text-slate-700">{new Intl.NumberFormat('es-PY', { style: 'currency', currency: 'PYG' }).format(totalsValidated.declared)}</p>
          </div>
        </div>

        {/* Charts Section */}
        {kpis && (Array.isArray(kpis.byReviewer) || Array.isArray(kpis.byCollector)) && (
          <div className="bg-white p-4 rounded-lg border shadow-sm grid md:grid-cols-2 gap-8">
            <div>
              <h4 className="text-xs font-bold text-slate-400 uppercase mb-4">Gerentes (Mes)</h4>
              <CompactBarChart
                rows={(kpis.byReviewer || [])
                  .filter((r: any) => r?.userId && r.userId !== 'system-auto')
                  .map((r: any) => ({
                    key: String(r.userId || r.username || r.name),
                    label: (r.name || r.username || r.userId).toString().slice(0, 20),
                    values: [Number(r.approved || 0), Number(r.rejected || 0)],
                    valueLabel: `${Number(r.approved || 0) + Number(r.rejected || 0)} casos`,
                  }))}
                seriesColors={['#16a34a', '#dc2626']}
                maxItems={6}
              />
            </div>
            <div>
              <h4 className="text-xs font-bold text-slate-400 uppercase mb-4">Cobradores (Cobros del mes aprobados)</h4>
              <CompactBarChart
                rows={(kpis.byCollector || []).map((r: any) => ({
                  key: String(r.userId || r.username || r.name),
                  label: (r.name || r.username || r.userId).toString().slice(0, 20),
                  values: [Number(r.sumApproved || 0)],
                }))}
                seriesColors={['#2563eb']}
                maxItems={6}
              />
            </div>

          </div>
        )}
      </div>

      {/* 5. Review Modal */}
      {selectedPayment && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-0 sm:p-4 backdrop-blur-sm animate-in fade-in">
          <div className="bg-white w-full max-w-2xl rounded-none sm:rounded-2xl shadow-2xl overflow-hidden max-h-[100dvh] sm:max-h-[90vh] flex flex-col">
            <div className="p-3 sm:p-4 border-b flex justify-between items-center bg-slate-50">
              <div className="flex items-center gap-3">
                <h3 className="font-bold">Detalle de Gestión</h3>
                {canIssueTicket(user?.role ?? '', paymentTicketIssued(selectedPayment)) && (selectedPayment.status === PaymentState.CONFIRMADO || selectedPayment.status === PaymentState.CONFIRMADO_MANUAL) && (
                  <button onClick={handlePrintTicket} className="flex items-center gap-1 bg-slate-800 text-white px-3 py-1 rounded-lg text-xs hover:bg-slate-700 transition">
                    <Printer className="w-3 h-3" /> Imprimir
                  </button>
                )}
              </div>
              <button onClick={closeReview} aria-label="Cerrar detalle" className="p-2 -mr-1 hover:bg-gray-200 rounded-full transition"><X className="w-5 h-5 text-gray-500" /></button>
            </div>

            <div className="p-4 sm:p-6 overflow-y-auto flex-1">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
                <div className="space-y-4">
                  <div className="bg-slate-50 p-4 rounded-xl border">
                    <span className="text-[10px] font-bold text-slate-400 uppercase">Monto Declarado</span>
                    <div className="text-3xl font-black text-slate-800 mt-1">
                      {new Intl.NumberFormat('es-PY', { style: 'currency', currency: 'PYG' }).format(selectedPayment.amount)}
                    </div>
                    <div className="mt-3 space-y-1 text-sm">
                      <p>Cliente: <span className="font-bold">{selectedPayment.clientName || 'N/A'}</span></p>
                      <p>Código: <span className="font-bold">{selectedPayment.clientCode || 'N/A'}</span></p>
                      <p>Ref: <span className="font-bold">{selectedPayment.paymentRef || 'N/A'}</span></p>
                      <p>Banco origen: <span className="font-bold">{selectedPayment.sourceBank || 'N/A'}</span></p>
                      <p>Cuenta destino: <span className="font-bold">{destinationLabel(selectedPayment.isAtlasAccount)}</span></p>
                    </div>
                  </div>

                  {selectedPayment.proofUrl && (
                    <div className="rounded-xl overflow-hidden border">
                      <ProofViewer proofUrl={selectedPayment.proofUrl} paymentId={selectedPayment.id} />
                    </div>
                  )}
                </div>

                <div className="space-y-4">
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Acciones</h4>

                  {isOpeningReview && (
                    <div className="flex items-center gap-2 text-xs text-slate-500" role="status">
                      <Loader2 className="w-4 h-4 animate-spin" /> Preparando la revisión…
                    </div>
                  )}

                  {bankMatches === null && !bankMatchesError && (
                    <div className="flex items-center gap-2 text-xs text-slate-500" role="status">
                      <Loader2 className="w-4 h-4 animate-spin" /> Verificando transferencias del banco…
                    </div>
                  )}
                  {bankMatchesError && (
                    <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800" role="alert">
                      <p>{bankMatchesError} La aprobación manual queda pausada.</p>
                      <button type="button" onClick={() => void loadBankMatches(selectedPayment.id)} className="mt-2 font-bold underline">
                        Reintentar consulta bancaria
                      </button>
                    </div>
                  )}
                  {manualRisk?.partialBankAllocation && (
                    <p className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800" role="alert">
                      Esta consulta ya tiene una conciliación bancaria parcial. Completá o revisá esa conciliación; no se puede aprobar manualmente.
                    </p>
                  )}
                  {!!manualRisk?.blockingMatches.length && (
                    <p className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800" role="alert">
                      Hay {manualRisk.blockingMatches.length === 1 ? 'una transferencia vinculada' : `${manualRisk.blockingMatches.length} transferencias vinculadas`} por referencia o concepto. Resolvé la conciliación bancaria antes de aprobar manualmente.
                    </p>
                  )}
                  {!!manualRisk?.claimedNonBlockingMatches.length && (
                    <p className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
                      Hay transferencias tomadas con datos del mismo cliente. Revisá las coincidencias indicadas abajo y explicá por qué este comprobante corresponde a otro ingreso.
                    </p>
                  )}
                  {selectedPayment.isAtlasAccount !== false && (
                    <p className="p-3 rounded-lg bg-sky-50 border border-sky-200 text-xs text-sky-900">
                      {selectedPayment.isAtlasAccount === true
                        ? 'Cuenta Atlas: solo se aprueba al tomar o conciliar una transferencia ya visible en la API. La aprobación manual está deshabilitada.'
                        : 'Consulta anterior sin banco de depósito: mirá el comprobante y registrá si entró a Atlas o a BNF antes de aprobar; no se presume ninguno.'}
                    </p>
                  )}
                  {selectedPayment.isAtlasAccount == null && canActOnPayment(selectedPayment) && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" aria-label="Registrar banco de depósito">
                      <button type="button" onClick={() => void handleClassifyDestination(true)}
                        disabled={isOpeningReview || isClassifyingDestination}
                        className="rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-2 text-xs font-bold text-indigo-900 hover:bg-indigo-100 disabled:opacity-50">
                        Se depositó en Atlas
                      </button>
                      <button type="button" onClick={() => void handleClassifyDestination(false)}
                        disabled={isOpeningReview || isClassifyingDestination}
                        className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900 hover:bg-amber-100 disabled:opacity-50">
                        Se depositó en BNF
                      </button>
                    </div>
                  )}

                  {isClaimActive(selectedPayment) && !isClaimMine(selectedPayment) ? (
                    <div className="p-3 bg-amber-50 text-amber-700 rounded-lg text-xs border border-amber-100 italic">
                      Este caso esta siendo revisado por: {selectedPayment.reviewClaimedByName || selectedPayment.reviewClaimedByUsername}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <input
                        type="text"
                        aria-label="Motivo u observación de la decisión"
                        placeholder="Motivo u observación..."
                        className="w-full text-sm p-3 border rounded-xl bg-gray-50 focus:bg-white transition"
                        value={reason}
                        onChange={e => setReason(e.target.value)}
                      />
                      <div className="flex flex-col sm:flex-row gap-2">
                        <button onClick={handleManualConfirm} disabled={isOpeningReview || isConfirmingManual || !manualApprovalReady || !canActOnPayment(selectedPayment)} className="flex-1 bg-green-600 text-white font-bold text-sm py-3 rounded-xl shadow-lg shadow-green-200 hover:bg-green-700 transition disabled:opacity-50">{isConfirmingManual ? 'VERIFICANDO…' : selectedPayment.isAtlasAccount === true ? 'SOLO CONCILIACIÓN API' : selectedPayment.isAtlasAccount == null ? 'CLASIFICAR DESTINO' : 'APROBAR'}</button>
                        <button onClick={handleReject}
                          disabled={isOpeningReview || !canActOnPayment(selectedPayment) || Number(selectedPayment.allocatedAmount ?? 0) > 0}
                          title={Number(selectedPayment.allocatedAmount ?? 0) > 0 ? 'Anulá la toma bancaria antes de rechazar' : undefined}
                          className="flex-1 bg-red-50 text-red-600 font-bold text-sm py-3 rounded-xl hover:bg-red-100 transition disabled:opacity-50">RECHAZAR</button>
                      </div>

                      {/* Undo / Cash Paid helpers */}
                      {(selectedPayment.status === PaymentState.CONFIRMADO || selectedPayment.status === PaymentState.CONFIRMADO_MANUAL || selectedPayment.status === PaymentState.RECHAZADO) &&
                        !selectedPayment.printedAt && !selectedPayment.cashPaidAt && (
                          <button onClick={handleUndoDecision} className="w-full text-xs text-amber-600 hover:underline">Anular decisión y volver a Pendiente</button>
                        )}

                      {selectedPayment.printedAt && !selectedPayment.cashPaidAt && (
                        <button onClick={handleCashPaid} className="w-full bg-blue-600 text-white font-bold py-3 rounded-xl hover:bg-blue-700 transition">Marcar Pago en Caja</button>
                      )}
                    </div>
                  )}

                  {bankMatches && bankMatches.length > 0 && (
                    <div className="pt-4 border-t">
                      <h4 className="text-xs font-bold text-indigo-600 uppercase mb-3">Comparación con transferencias del banco</h4>
                      <div className="space-y-2 max-h-[180px] overflow-y-auto pr-1">
                        {bankMatches.map((t) => (
                          <div key={t.id} className="p-2 rounded-lg border text-xs bg-slate-50 border-slate-200">
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <p className="font-bold text-slate-700 truncate">
                                  {formatBankMoney(t.amount, t.currency)} · {t.senderName || 'Remitente no informado'}
                                </p>
                                <p className="text-slate-500">{formatBankDateTime(t.movementAt)}{t.senderNote ? ` · “${t.senderNote}”` : ''}</p>
                                <p className="text-slate-600">Origen: {t.senderBankName || 'no informado'} · Doc. {t.bankDocNumber || 'no informado'}</p>
                              </div>
                              <div className="flex flex-col items-end gap-1 shrink-0">
                                <BankStatusBadge status={t.status} />
                                {t.match && <MatchBadge match={t.match} />}
                                {t.availableAmount > 0 && isSupportedBankCurrency(t.currency) && user?.role === UserRole.ADMIN && canUseApiFlow(selectedPayment.isAtlasAccount) && canActOnPayment(selectedPayment) && (
                                  <button
                                    onClick={() => void handleReconcile(t)}
                                    disabled={reconcilingId !== null}
                                    className="px-2 py-1 bg-indigo-600 text-white text-[10px] font-bold rounded hover:bg-indigo-700 disabled:opacity-50"
                                  >
                                    {reconcilingId === t.id ? 'Conciliando…' : 'Conciliar'}
                                  </button>
                                )}
                              </div>
                            </div>
                            {t.match?.reason && <p className="mt-1 text-slate-700">{t.match.reason}</p>}
                            {t.claims?.length > 0 && (
                              <p className="mt-1 font-semibold text-red-700">{claimsSummary(t)}. No usar esta transferencia para esta consulta.</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="pt-4 border-t">
                    <h4 className="text-xs font-bold text-slate-400 uppercase mb-3">Historial</h4>
                    <div className="space-y-2 max-h-[150px] overflow-y-auto pr-2">
                      {auditLogs.map(log => (
                        <div key={log.id} className="text-[10px] border rounded-lg p-2 bg-slate-50">
                          <div className="flex justify-between font-bold text-slate-700">
                            <span>{auditActionLabel(log.action)} · {auditActor(log).name}</span>
                            <span className="text-slate-400">{(parseDbTimestamp(log.timestamp) ?? new Date(log.timestamp)).toLocaleTimeString('es-PY', { timeZone: 'America/Asuncion' })}</span>
                          </div>
                          <p className="text-slate-500 mt-1">{describeAudit(log)}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export { AdminDashboard };
