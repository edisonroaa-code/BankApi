import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle, FileText, Loader2, Pencil, Printer, RefreshCw, Search, Upload, X } from 'lucide-react';
import { api, isNativeApp } from '../services/api';
import { parseDbTimestamp } from '../services/date';
import { createRealtimeSocket, PaymentsRealtimeEvent } from '../services/realtime';
import { fetchPaymentDetail, fetchPaymentsPage, openPaymentTicket, upsertPayment } from '../services/payments';
import { onPaymentPrinted, onTicketIssued } from '../services/print-events';
import { canIssueTicket, paymentTicketIssued } from '../services/print-policy';
import { DEPOSIT_BANK_OPTIONS, DEPOSIT_BANK_REQUIRED, destinationLabel, isDepositBankChosen } from '../services/payment-destination';
import {
  clearConsultaDraft,
  EMPTY_CONSULTA_DRAFT,
  isConsultaDraftEmpty,
  loadConsultaDraftFields,
  loadConsultaDraftFile,
  saveConsultaDraftFields,
  saveConsultaDraftFile,
} from '../services/consulta-draft';
import { Payment, PaymentState, User } from '../types';
import { CompactBarChart } from '../components/CompactBarChart';
import { StatusBadge } from '../components/ui';
import { Trophy } from 'lucide-react';

/* ── Skeleton Components ─────────────────────────── */
// Respaldo por si el WebSocket esta bloqueado. Debe superar los 5 min de
// autosuspend de Neon: un poll mas corto deja el compute encendido toda la
// jornada y agota la cuota mensual sin trabajo real.
const FALLBACK_POLL_MS = 15 * 60 * 1000;
const MAX_PROOF_BYTES = 10 * 1024 * 1024;
const ALLOWED_PROOF_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp',
  'image/gif', 'image/tiff', 'image/tif', 'image/heic', 'image/heif', 'application/pdf',
]);

const SkeletonCard = () => (
  <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-100 animate-pulse">
    <div className="flex justify-between items-start mb-2">
      <div className="space-y-2 flex-1">
        <div className="skeleton h-5 w-32" />
        <div className="skeleton h-3 w-48" />
      </div>
      <div className="skeleton h-6 w-20 rounded-full" />
    </div>
    <div className="skeleton h-3 w-full mt-3" />
    <div className="flex justify-between pt-3 mt-3 border-t border-gray-50">
      <div className="skeleton h-3 w-28" />
      <div className="skeleton h-6 w-16 rounded" />
    </div>
  </div>
);

const SkeletonList = ({ count = 3 }: { count?: number }) => (
  <div className="space-y-3">
    {Array.from({ length: count }).map((_, i) => (
      <SkeletonCard key={i} />
    ))}
  </div>
);

export const CobradorDashboard = ({
  user,
  showToast,
  onPrint,
}: {
  user: User;
  showToast: (t: 'success' | 'error' | 'info', m: string) => void;
  onPrint: (p: Payment) => void;
}) => {
  const [mobileTab, setMobileTab] = useState<'NEW' | 'LIST' | 'RANK'>('NEW');
  // Una recarga de la página no borra lo que se estaba cargando: se retoma el borrador guardado.
  // Sin valor por defecto para el banco de depósito: el cobrador elige Atlas o BNF en cada consulta.
  const [initialDraft] = useState(() => loadConsultaDraftFields(user.id));
  const [paymentState, setPaymentState] = useState(initialDraft ?? EMPTY_CONSULTA_DRAFT);
  const [file, setFile] = useState<File | null>(null);
  const [draftRestored, setDraftRestored] = useState(initialDraft !== null);
  // El comprobante guardado se lee aparte (IndexedDB es asíncrono): hasta leerlo no se pisa.
  const [proofDraftReady, setProofDraftReady] = useState(false);
  const savedProofRef = useRef<File | null>(null);
  const restoreRunRef = useRef(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotalPages, setHistoryTotalPages] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [kpis, setKpis] = useState<any>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  const [dragActive, setDragActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [paymentsLoadError, setPaymentsLoadError] = useState(false);
  const refreshInFlightRef = useRef(false);
  const latestPaymentsRequestRef = useRef(0);
  const lastNotifiedRef = useRef<Record<string, true>>({});

  const filePickerRef = useRef<HTMLInputElement | null>(null);
  const cameraPickerRef = useRef<HTMLInputElement | null>(null);
  const listContainerRef = useRef<HTMLDivElement | null>(null);

  /* ── Pull-to-refresh ─────────────────────────────── */
  const pullStartY = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);
  const isPulling = useRef(false);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (listContainerRef.current && listContainerRef.current.scrollTop === 0) {
      pullStartY.current = e.touches[0].clientY;
      isPulling.current = true;
    }
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isPulling.current) return;
    const diff = e.touches[0].clientY - pullStartY.current;
    if (diff > 0 && diff < 120) {
      setPullDistance(diff);
    }
  }, []);

  const getUserId = useCallback((u: string | User | undefined) => {
    if (!u) return '';
    return typeof u === 'string' ? u : u.id;
  }, []);

  const fetchPayments = useCallback(async (page = 1): Promise<boolean | null> => {
    const requestId = ++latestPaymentsRequestRef.current;
    try {
      const data = await fetchPaymentsPage({ page, pageSize: 50 });
      if (requestId !== latestPaymentsRequestRef.current) return null;
      setPayments(data.items);
      setHistoryPage(data.page);
      setHistoryTotalPages(data.totalPages);
      setHistoryTotal(data.total);
      setInitialLoad(false);
      setPaymentsLoadError(false);
      return true;
    } catch {
      if (requestId !== latestPaymentsRequestRef.current) return null;
      setInitialLoad(false);
      setPaymentsLoadError(true);
      return false;
    }
  }, []);

  const fetchKpis = useCallback(async () => {
    try {
      const { data } = await api.get('/payments/kpis');
      setKpis(data);
    } catch { /* ignore */ }
  }, []);

  const refreshConsultations = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setIsRefreshing(true);
    try {
      const updated = await fetchPayments(historyPage);
      void fetchKpis();
      if (updated === null) return;
      showToast(updated ? 'success' : 'error', updated
        ? 'Consultas actualizadas.'
        : 'No se pudieron actualizar las consultas. Los datos visibles pueden estar desactualizados.');
    } finally {
      refreshInFlightRef.current = false;
      setIsRefreshing(false);
    }
  }, [fetchPayments, fetchKpis, historyPage, showToast]);

  const handleTouchEnd = useCallback(async () => {
    if (pullDistance > 60) await refreshConsultations();
    setPullDistance(0);
    isPulling.current = false;
  }, [pullDistance, refreshConsultations]);

  const handleEdit = (p: Payment) => {
    if (loading) return;
    setPaymentState({
      amount: new Intl.NumberFormat('es-PY').format(p.amount),
      client: p.clientName || '',
      clientCode: p.clientCode || '',
      refNum: p.paymentRef || '',
      sourceBank: p.sourceBank || '',
      isAtlasAccount: p.isAtlasAccount ?? null,
    });
    setEditingId(p.id);
    setMobileTab('NEW'); // Switch to form tab on mobile
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /** Vuelve a la consulta nueva con lo que quedó guardado en este dispositivo (datos y comprobante). */
  const restoreDraft = useCallback(() => {
    const fields = loadConsultaDraftFields(user.id);
    setPaymentState(fields ?? EMPTY_CONSULTA_DRAFT);
    setDraftRestored(fields !== null);
    setFile(null);
    savedProofRef.current = null;
    setProofDraftReady(false);
    let active = true;
    const run = ++restoreRunRef.current;
    void loadConsultaDraftFile(user.id).then((saved) => {
      // Si mientras tanto se limpió el formulario, el comprobante leído ya no corresponde.
      if (!active || run !== restoreRunRef.current) return;
      if (saved) {
        savedProofRef.current = saved;
        setFile((current) => current ?? saved);
        setDraftRestored(true);
      }
      setProofDraftReady(true);
    });
    return () => {
      active = false;
    };
  }, [user.id]);

  useEffect(() => restoreDraft(), [restoreDraft]);

  // Cada cambio de la consulta nueva queda guardado; mientras se edita una ya enviada, no.
  useEffect(() => {
    if (!editingId) saveConsultaDraftFields(user.id, paymentState);
  }, [editingId, paymentState, user.id]);

  useEffect(() => {
    if (editingId || !proofDraftReady || file === savedProofRef.current) return;
    savedProofRef.current = file;
    void saveConsultaDraftFile(user.id, file);
  }, [editingId, file, proofDraftReady, user.id]);

  /** Formulario en blanco y sin borrador: la consulta se envió o el cobrador la descartó. */
  const startNewConsulta = () => {
    clearConsultaDraft(user.id);
    restoreRunRef.current += 1;
    setProofDraftReady(true);
    savedProofRef.current = null;
    setPaymentState(EMPTY_CONSULTA_DRAFT);
    setFile(null);
    setDraftRestored(false);
    setEditingId(null);
  };

  /** Deja de editar una consulta enviada y retoma la nueva que se estaba cargando, si había una. */
  const cancelEdit = () => {
    setEditingId(null);
    restoreDraft();
  };

  const getDecisionReason = (p: Payment) => {
    if (p.decisionReason && p.decisionReason.trim()) return p.decisionReason.trim();
    if (p.rejectionReason && p.rejectionReason.trim()) return p.rejectionReason.trim();
    return '';
  };

  // Confirmado "Sí, salió impreso" en esta app: la fila pasa a "Re-imprimir" y habilita la caja al instante.
  useEffect(() => onPaymentPrinted((printed) => {
    latestPaymentsRequestRef.current += 1;
    setPayments((prev) => (prev.some((p) => p.id === printed.id) ? upsertPayment(prev, printed) : prev));
  }), []);

  const canMarkCashPaid = (p: Payment) => {
    const isMine = getUserId(p.createdBy) === user.id || p.createdById === user.id;
    const isConfirmed = p.status === PaymentState.CONFIRMADO || p.status === PaymentState.CONFIRMADO_MANUAL;
    return isMine && isConfirmed && !!p.printedAt && !p.cashPaidAt;
  };

  const handleCashPaid = async (payment: Payment) => {
    try {
      const { data } = await api.post(`/payments/${payment.id}/cash-paid`);
      latestPaymentsRequestRef.current += 1;
      setPayments((prev) => upsertPayment(prev, data));
      showToast('success', 'Marcado como pago en caja.');
    } catch (e: any) {
      const msg = e?.response?.data?.message;
      showToast('error', msg ? String(msg) : 'No se pudo marcar caja.');
    }
  };

  useEffect(() => {
    fetchPayments(historyPage);
    fetchKpis();
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      fetchPayments(historyPage);
      fetchKpis();
    }, FALLBACK_POLL_MS);
    return () => clearInterval(interval);
  }, [fetchPayments, fetchKpis, historyPage]);

  useEffect(() => {
    const socket = createRealtimeSocket();
    socket.on('payments:changed', async (evt: PaymentsRealtimeEvent) => {
      const refreshTypes = new Set([
        'PAYMENT_CONFIRMED_MANUAL',
        'PAYMENT_MATCH_CONFIRMED',
        'PAYMENT_AUTO_CONFIRMED',
        'PAYMENT_REJECTED',
        'PAYMENT_DECISION_UNDONE',
        'PAYMENT_UPDATED',
        // Impreso o pagado en caja (por esta u otra pantalla): actualiza la fila sin avisar de nuevo.
        'PAYMENT_PRINTED',
        'PAYMENT_CASH_PAID',
      ]);
      if (!evt?.paymentId || !refreshTypes.has(evt.type)) return;
      if (evt.targetUserId && evt.targetUserId !== user.id) return;

      const key = `${evt.paymentId}:${evt.type}`;
      if (lastNotifiedRef.current[key]) return;

      let pay: Payment;
      try {
        pay = await fetchPaymentDetail(evt.paymentId);
      } catch {
        return;
      }
      const isMine = getUserId(pay.createdBy) === user.id || pay.createdById === user.id;
      if (!isMine) return;

      latestPaymentsRequestRef.current += 1;
      setPayments((prev) => upsertPayment(prev, pay));
      if (evt.type === 'PAYMENT_UPDATED' || evt.type === 'PAYMENT_PRINTED' || evt.type === 'PAYMENT_CASH_PAID') return;

      const isApproved = pay.status === PaymentState.CONFIRMADO || pay.status === PaymentState.CONFIRMADO_MANUAL;
      const isRejected = pay.status === PaymentState.RECHAZADO;
      const isUndone = evt.type === 'PAYMENT_DECISION_UNDONE' && pay.status === PaymentState.PENDIENTE_VERIFICACION;
      if (!isApproved && !isRejected && !isUndone) return;

      lastNotifiedRef.current[key] = true;

      const tag = pay.clientCode || pay.paymentRef || pay.id.slice(0, 8);
      const reason = getDecisionReason(pay);
      const title = isUndone ? 'Decisión anulada' : isApproved ? 'Consulta aprobada' : 'Consulta rechazada';
      const body = `${tag}${reason ? ` · Motivo: ${reason}` : ''}`;

      if (isApproved) showToast('success', `${title}: ${tag}`);
      if (isRejected) showToast('error', `${title}: ${tag}`);
      if (isUndone) showToast('info', `${title}: ${tag}`);

      if (typeof window !== 'undefined' && 'Notification' in window) {
        try {
          if (Notification.permission === 'granted') {
            new Notification(title, { body });
          } else if (Notification.permission === 'default') {
            Notification.requestPermission().catch(() => { });
          }
        } catch {
          // ignore
        }
      }
    });

    return () => socket.disconnect();
  }, [getUserId, showToast, user.id]);

  useEffect(() => {
    if (!file || !file.type.startsWith('image/')) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const isAllowedProofFile = (f: File) => {
    const type = (f.type || '').toLowerCase();
    return ALLOWED_PROOF_TYPES.has(type);
  };

  const handleDropFile = (f: File) => {
    if (f.size === 0 || f.size > MAX_PROOF_BYTES) {
      showToast('error', 'El comprobante debe pesar como máximo 10 MB.');
      return;
    }
    if (!isAllowedProofFile(f)) {
      showToast('error', 'Archivo no válido. Usá una foto compatible o un PDF.');
      return;
    }
    setFile(f);
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/\D/g, '');
    if (!raw) {
      setPaymentState((prev) => ({ ...prev, amount: '' }));
      return;
    }
    const val = parseInt(raw, 10);
    setPaymentState((prev) => ({ ...prev, amount: new Intl.NumberFormat('es-PY').format(val) }));
  };

  const canSubmit = useMemo(() => {
    return !!(
      paymentState.amount.trim() &&
      paymentState.clientCode.trim() &&
      paymentState.refNum.trim() &&
      paymentState.sourceBank.trim() &&
      isDepositBankChosen(paymentState.isAtlasAccount) &&
      file &&
      !loading
    );
  }, [file, loading, paymentState.amount, paymentState.clientCode, paymentState.refNum, paymentState.sourceBank, paymentState.isAtlasAccount]);

  const onFormKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (!editingId && !canSubmit) {
        e.preventDefault();
        showToast('error', 'Por favor completá todos los campos obligatorios y subí el comprobante antes de enviar.');
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;

    // For editing, file is not required
    const isEditing = !!editingId;
    const isAtlasAccount = paymentState.isAtlasAccount;
    if (!isDepositBankChosen(isAtlasAccount)) {
      showToast('error', DEPOSIT_BANK_REQUIRED);
      return;
    }
    if (!isEditing && !canSubmit) {
      showToast('error', 'Formulario incompleto o procesando.');
      return;
    }

    const numericAmount = parseInt(paymentState.amount.replace(/\./g, ''), 10);
    if (!numericAmount || numericAmount <= 0) {
      showToast('error', 'El monto debe ser mayor a 0.');
      return;
    }

    setLoading(true);

    try {
      if (isEditing) {
        // PATCH request for editing
        const { data } = await api.patch(`/payments/${editingId}`, {
          amount: numericAmount,
          clientName: paymentState.client,
          clientCode: paymentState.clientCode,
          paymentRef: paymentState.refNum,
          sourceBank: paymentState.sourceBank,
          isAtlasAccount,
          observation: `Ref: ${paymentState.refNum} - Cód: ${paymentState.clientCode} - Banco origen: ${paymentState.sourceBank}`,
        });
        latestPaymentsRequestRef.current += 1;
        setPayments((prev) => upsertPayment(prev, data));
        showToast('success', 'Pago actualizado correctamente.');
      } else {
        // POST request for new payment
        const formData = new FormData();
        formData.append('amount', numericAmount.toString());
        formData.append('clientName', paymentState.client);
        formData.append('clientCode', paymentState.clientCode);
        formData.append('paymentRef', paymentState.refNum);
        formData.append('sourceBank', paymentState.sourceBank);
        formData.append('isAtlasAccount', String(isAtlasAccount));
        formData.append(
          'observation',
          `Ref: ${paymentState.refNum} - Cód: ${paymentState.clientCode} - Banco origen: ${paymentState.sourceBank}`,
        );
        if (file) formData.append('file', file);

        const { data } = await api.post('/payments', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
        latestPaymentsRequestRef.current += 1;
        setInitialLoad(false);
        setPayments((prev) => upsertPayment(prev, data).slice(0, 50));
        setHistoryTotal((prev) => prev + 1);
        showToast('success', 'Pago registrado y enviado a revisión correctamente.');
      }

      // La nueva ya está en el servidor: su borrador se borra. Tras editar, se retoma la que se cargaba.
      if (isEditing) cancelEdit();
      else startNewConsulta();
      if (isNativeApp && !isEditing) setMobileTab('LIST');
    } catch (e: any) {
      if (e.code === 'ERR_NETWORK') {
        showToast('error', 'Error de red: no se pudo enviar el cobro. Tu formulario sigue activo, por favor intentá nuevamente cuando vuelva la red.');
      } else {
        showToast('error', e.response?.data?.message || (isEditing ? 'Error al actualizar el pago.' : 'Error al registrar el pago.'));
      }
    } finally {
      setLoading(false);
    }
  };
  const handlePrintRequest = async (payment: Payment) => {
    if (isNativeApp) {
      showToast('error', 'La impresión de tickets está disponible solo en PC.');
      return;
    }
    try {
      const wasAlreadyPrinted = !!payment.printedAt;
      // Se cuenta como impreso recién cuando se confirma que salió (al cerrar el diálogo).
      const data = await openPaymentTicket(payment.id);
      onPrint({ ...data, reprint: wasAlreadyPrinted });
    } catch {
      showToast('error', 'No se pudo abrir el ticket.');
    }
  };

  /* ── Filtered payments with search ─────────────── */
  const filteredPayments = useMemo(() => {
    if (!searchQuery.trim()) return payments;
    const q = searchQuery.toLowerCase().trim();
    return payments.filter((p) =>
      (p.paymentRef || '').toLowerCase().includes(q) ||
      (p.clientCode || '').toLowerCase().includes(q) ||
      (p.clientName || '').toLowerCase().includes(q) ||
      (p.sourceBank || '').toLowerCase().includes(q)
    );
  }, [payments, searchQuery]);

  /* ── Pending count for bottom nav badge ──────────── */
  const pendingCount = useMemo(() => {
    return payments.filter((p) => p.status === PaymentState.PENDIENTE_VERIFICACION).length;
  }, [payments]);

  const switchTab = (tab: 'NEW' | 'LIST' | 'RANK') => {
    setMobileTab(tab);
    window.scrollTo({ top: 0 });
  };


  return (
    <div className="space-y-6 pb-safe mb-24 md:mb-0">
      {/* ── NEW TAB: Registration form ─────────────── */}
      <div className={`${mobileTab !== 'NEW' ? 'hidden' : 'tab-panel-enter'} md:block bg-white p-6 rounded-lg shadow-sm border border-gray-100`}>
        <h2 className="text-lg font-bold mb-4 flex items-center gap-2 text-slate-800">
          <Upload className="w-5 h-5 text-blue-600" /> Registrar nuevo cobro
        </h2>

        {draftRestored && !editingId && (
          <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <span>Retomamos la consulta que estabas cargando: quedó guardada en este equipo.</span>
            <button
              type="button"
              onClick={startNewConsulta}
              disabled={loading}
              className="rounded border border-amber-300 bg-white px-3 py-1 text-xs font-semibold hover:bg-amber-100"
            >
              Empezar de cero
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} onKeyDown={onFormKeyDown} aria-busy={loading}>
          {/* La respuesta del envío limpia esta consulta: no aceptar otra carga mientras espera. */}
          <fieldset disabled={loading} className="min-w-0 space-y-4">
          <div className="bg-blue-50 p-4 rounded-md border border-blue-100 text-sm text-blue-800 mb-4">
            <p className="font-semibold flex items-center gap-2">
              <AlertCircle className="w-4 h-4" /> Datos de auditoría interna
            </p>
            <p className="mt-1 opacity-90">Por favor completá todos los campos para autorizar el envío del comprobante.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Monto del comprobante (PYG) *</label>
              <input
                type="text"
                inputMode="numeric"
                required
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-lg font-bold text-slate-800 transition-shadow"
                placeholder="0"
                value={paymentState.amount}
                onChange={handleAmountChange}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nro. referencia *</label>
              <input
                type="text"
                required
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none transition-shadow"
                placeholder="Ej. 123456"
                value={paymentState.refNum}
                onChange={(e) => setPaymentState((prev) => ({ ...prev, refNum: e.target.value }))}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Banco origen *</label>
              <input
                type="text"
                required
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none transition-shadow"
                placeholder="Ej. Itaú"
                value={paymentState.sourceBank}
                onChange={(e) => setPaymentState((prev) => ({ ...prev, sourceBank: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Código de cliente *</label>
              <input
                type="text"
                required
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none transition-shadow"
                placeholder="Ej. CLI-001"
                value={paymentState.clientCode}
                onChange={(e) => setPaymentState((prev) => ({ ...prev, clientCode: e.target.value }))}
              />
            </div>
          </div>

          <fieldset className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-slate-800">
            <legend className="px-1 text-sm font-semibold text-gray-700">¿En qué banco se depositó? *</legend>
            <div className="grid grid-cols-2 gap-2">
              {DEPOSIT_BANK_OPTIONS.map((option) => {
                const selected = paymentState.isAtlasAccount === option.isAtlasAccount;
                return (
                  <label
                    key={option.label}
                    className={`flex cursor-pointer items-start gap-2 rounded-lg border-2 p-3 transition ${selected ? 'border-sky-600 bg-white shadow-sm' : 'border-slate-200 bg-white/60 hover:border-sky-300'}`}
                  >
                    <input
                      type="radio"
                      name="depositBank"
                      required
                      checked={selected}
                      onChange={() => setPaymentState((prev) => ({ ...prev, isAtlasAccount: option.isAtlasAccount }))}
                      className="mt-1 h-4 w-4 shrink-0 accent-sky-700"
                    />
                    <span>
                      <span className="block text-base font-bold text-slate-800">{option.label}</span>
                      <span className="block text-xs text-slate-600">{option.detail}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-slate-600">
              Es nuestra cuenta donde entró la plata, según el comprobante. “Banco origen” es desde dónde envió el cliente y no decide esto.
            </p>
            {editingId && !isDepositBankChosen(paymentState.isAtlasAccount) && (
              <p className="mt-2 text-xs font-semibold text-amber-900" role="alert">
                Consulta anterior sin banco de depósito: elegí Atlas o BNF antes de guardar.
              </p>
            )}
          </fieldset>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Nombre cliente (opcional)</label>
            <input
              type="text"
              className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none transition-shadow"
              placeholder="Razón social / nombre"
              value={paymentState.client}
              onChange={(e) => setPaymentState((prev) => ({ ...prev, client: e.target.value }))}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Adjuntar comprobante (PDF/Foto) *</label>
            <div
              className={`border-2 border-dashed rounded-lg p-4 transition ${dragActive ? 'border-blue-400 bg-blue-50' : 'border-gray-300 hover:bg-gray-50'
                }`}
              onDragEnter={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (isNativeApp || loading) return;
                setDragActive(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (isNativeApp || loading) return;
                e.dataTransfer.dropEffect = 'copy';
                setDragActive(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragActive(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragActive(false);
                if (isNativeApp || loading) return;
                const dropped = e.dataTransfer?.files?.[0];
                if (dropped) handleDropFile(dropped);
              }}
            >
              <input
                ref={filePickerRef}
                type="file"
                accept="image/*,application/pdf"
                className="hidden"
                onChange={(e) => {
                  const next = e.target.files?.[0];
                  if (!next) return setFile(null);
                  handleDropFile(next);
                }}
              />
              <input
                ref={cameraPickerRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => {
                  const next = e.target.files?.[0];
                  if (!next) return setFile(null);
                  handleDropFile(next);
                }}
              />

              {!file ? (
                <div className="text-center text-gray-500 flex flex-col items-center gap-3">
                  <FileText className="w-8 h-8 text-gray-400" />
                  {!isNativeApp && (
                    <div className="text-xs text-gray-400">Tip: también podés arrastrar y soltar el archivo aquí.</div>
                  )}
                  <div className="text-sm">{isNativeApp ? 'Elegí cómo cargar el comprobante' : 'Seleccioná un archivo'}</div>
                  <div className="flex flex-col sm:flex-row gap-2 w-full sm:justify-center">
                    {isNativeApp && (
                      <button
                        type="button"
                        onClick={() => cameraPickerRef.current?.click()}
                        className="w-full sm:w-auto px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold active:scale-95 transition-transform"
                      >
                        Tomar foto
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => filePickerRef.current?.click()}
                      className="w-full sm:w-auto px-4 py-2 rounded-lg border bg-white font-semibold text-slate-800 active:scale-95 transition-transform"
                    >
                      {isNativeApp ? 'Elegir archivo / PDF' : 'Elegir archivo'}
                    </button>
                  </div>
                  <div className="text-xs text-gray-400">
                    Tip: acercá el comprobante, evitá reflejos y esperá el enfoque antes de sacar la foto.
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3">
                  <div className="shrink-0">
                    {previewUrl ? (
                      <img src={previewUrl} alt="Vista previa" className="w-16 h-16 rounded object-cover border" />
                    ) : (
                      <div className="w-16 h-16 rounded border flex items-center justify-center bg-white">
                        <FileText className="w-6 h-6 text-gray-400" />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <CheckCircle className="w-5 h-5 text-green-600" />
                      <span className="font-medium text-slate-800 truncate">{file.name}</span>
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {file.type || 'archivo'} · {Math.round(file.size / 1024)} KB
                    </div>
                    <div className="flex gap-2 mt-3 flex-wrap">
                      <button
                        type="button"
                        onClick={() => setFile(null)}
                        className="px-3 py-1.5 text-xs rounded border bg-white hover:bg-gray-50 active:scale-95 transition-transform"
                      >
                        Quitar
                      </button>
                      {isNativeApp && (
                        <button
                          type="button"
                          onClick={() => cameraPickerRef.current?.click()}
                          className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 active:scale-95 transition-transform"
                        >
                          Rehacer foto
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => filePickerRef.current?.click()}
                        className="px-3 py-1.5 text-xs rounded border bg-white hover:bg-gray-50 active:scale-95 transition-transform"
                      >
                        Cambiar
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex gap-3">
            {editingId && (
              <button
                type="button"
                onClick={cancelEdit}
                className="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-700 py-3 rounded-lg font-bold shadow-md transition active:scale-[0.98]"
              >
                Cancelar
              </button>
            )}
            {/* Recargar la página ya no vacía el formulario: este botón lo hace a propósito. */}
            {!editingId && (file || !isConsultaDraftEmpty(paymentState)) && (
              <button
                type="button"
                onClick={startNewConsulta}
                disabled={loading}
                className="px-4 bg-gray-100 hover:bg-gray-200 text-gray-700 py-3 rounded-lg font-semibold transition disabled:opacity-50"
              >
                Limpiar
              </button>
            )}
            <button
              type="submit"
              disabled={editingId ? loading : !canSubmit}
              className={`flex-1 py-3 rounded-lg font-bold shadow-md transition disabled:opacity-50 flex items-center justify-center gap-2 active:scale-[0.98] ${editingId ? 'bg-green-600 hover:bg-green-700 text-white' : 'bg-blue-600 hover:bg-blue-700 text-white'
                }`}
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" /> Procesando...
                </>
              ) : editingId ? (
                'Guardar cambios'
              ) : (
                'Autorizar y enviar a revisión'
              )}
            </button>
          </div>
          </fieldset>
        </form>
      </div>

      {/* ── LIST TAB: Payment history with search ───── */}
      <div
        ref={listContainerRef}
        className={`${mobileTab !== 'LIST' ? 'hidden' : 'tab-panel-enter'} md:block`}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* Pull-to-refresh indicator */}
        {pullDistance > 10 && (
          <div
            className="flex items-center justify-center transition-all overflow-hidden"
            style={{ height: `${Math.min(pullDistance, 60)}px`, opacity: pullDistance / 60 }}
          >
            <RefreshCw className={`w-5 h-5 text-blue-500 ${pullDistance > 60 ? 'pull-refresh-spinner' : ''}`} />
            <span className="text-xs text-gray-500 ml-2">
              {pullDistance > 60 ? 'Soltar para refrescar' : 'Arrastrá para refrescar'}
            </span>
          </div>
        )}
        <div className="flex items-center justify-between mb-3 px-1">
          <h3 className="text-lg font-semibold text-slate-700">Mis pagos</h3>
          <div className="flex items-center gap-2 sm:gap-3">
            <span className="text-xs text-gray-400">{historyTotal} registros</span>
            <button
              type="button"
              onClick={refreshConsultations}
              disabled={isRefreshing}
              aria-busy={isRefreshing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-gray-50 disabled:cursor-wait disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
              {isRefreshing ? 'Actualizando...' : 'Actualizar'}
            </button>
          </div>
        </div>

        {paymentsLoadError && (
          <p role="alert" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            No se pudieron cargar las consultas. Los datos visibles pueden estar desactualizados.
          </p>
        )}

        {/* Search bar */}
        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="search"
            placeholder="Buscar por referencia, código, cliente..."
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

        <div className="space-y-3">
          {initialLoad ? (
            <SkeletonList count={4} />
          ) : paymentsLoadError && payments.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-500">No se pudo comprobar si ingresó el pago. Pulsá Actualizar para reintentar.</div>
          ) : filteredPayments.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-gray-400">{searchQuery ? 'No se encontraron resultados.' : 'No hay pagos registrados.'}</p>
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="mt-2 text-sm text-blue-600 hover:underline"
                >
                  Limpiar búsqueda
                </button>
              )}
            </div>
          ) : (
            filteredPayments.map((pay) => (
              <div key={pay.id} className="bg-white p-4 rounded-lg shadow-sm border border-gray-100 transition-colors">
                <div className="flex justify-between items-start mb-2 gap-3">
                  <div className="min-w-0">
                    <p className="font-bold text-slate-800 text-lg">
                      {new Intl.NumberFormat('es-PY', { style: 'currency', currency: 'PYG' }).format(pay.amount)}
                    </p>
                    <p className="text-xs text-gray-500 truncate">
                      Ref: {pay.paymentRef} | Cliente: {pay.clientCode}
                    </p>
                    <p className="text-xs text-slate-600 mt-1">Destino: {destinationLabel(pay.isAtlasAccount)}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <StatusBadge status={pay.status} />
                    {pay.cashPaidAt ? (
                      <span className="text-[10px] bg-green-700 text-white px-1.5 rounded">CAJA OK</span>
                    ) : pay.printedAt ? (
                      <span className="text-[10px] bg-gray-800 text-white px-1.5 rounded">IMPRESO</span>
                    ) : null}
                  </div>
                </div>
                {(pay.status === PaymentState.RECHAZADO ||
                  pay.status === PaymentState.CONFIRMADO ||
                  pay.status === PaymentState.CONFIRMADO_MANUAL) && (
                    <div className="text-xs text-slate-700 bg-slate-50 border border-slate-100 rounded p-2 mt-2">
                      {pay.status === PaymentState.RECHAZADO ? (
                        <div>
                          <span className="font-semibold text-red-700">Motivo:</span>{' '}
                          <span>{getDecisionReason(pay) || 'Sin motivo registrado'}</span>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-1">
                          <div>
                            <span className="font-semibold text-green-700">Aprobado por:</span>{' '}
                            <span>{pay.verifiedByName || pay.verifiedByUsername || 'Sistema'}</span>
                          </div>
                          <div>
                            <span className="font-semibold">Motivo:</span>{' '}
                            <span>{getDecisionReason(pay) || 'Sin motivo registrado'}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                {canMarkCashPaid(pay) && (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => handleCashPaid(pay)}
                      className="w-full bg-green-600 hover:bg-green-700 text-white py-2 rounded-lg text-xs font-bold shadow-sm transition active:scale-[0.98]"
                    >
                      Marcar: pago en caja efectuado
                    </button>
                    <p className="text-[11px] text-gray-500 mt-1">
                      Solo para tus pagos, luego de imprimir el ticket.
                    </p>
                  </div>
                )}

                <div className="text-xs text-gray-400 flex justify-between pt-2 border-t border-gray-50 items-center">
                  <span>
                    {(parseDbTimestamp(pay.createdAt) ?? new Date(pay.createdAt)).toLocaleString('es-PY', { timeZone: 'America/Asuncion' })}
                  </span>

                  <div className="flex gap-2">
                    {pay.status === PaymentState.PENDIENTE_VERIFICACION && Number(pay.allocatedAmount ?? 0) === 0 && (
                      <button
                        onClick={() => handleEdit(pay)}
                        className="flex items-center gap-1 px-3 py-1 rounded text-xs bg-blue-100 text-blue-700 hover:bg-blue-200 transition active:scale-95"
                      >
                        <Pencil className="w-3 h-3" /> Editar
                      </button>
                    )}

                    {!isNativeApp && canIssueTicket(user.role, paymentTicketIssued(pay)) && (pay.status === PaymentState.CONFIRMADO || pay.status === PaymentState.CONFIRMADO_MANUAL) && (
                      <button
                        onClick={() => handlePrintRequest(pay)}
                        className={`flex items-center gap-1 px-3 py-1 rounded text-xs transition active:scale-95 ${pay.printedAt ? 'bg-gray-200 text-gray-600' : 'bg-slate-800 text-white hover:bg-slate-700'
                          }`}
                      >
                        <Printer className="w-3 h-3" /> {pay.printedAt ? 'Re-imprimir' : 'Imprimir ticket'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
          <div className="flex items-center justify-between gap-3 pt-3">
            <span className="text-xs text-gray-500">
              Página {historyPage} de {historyTotalPages}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={historyPage <= 1}
                onClick={() => fetchPayments(historyPage - 1)}
                className="px-3 py-1.5 text-xs rounded border bg-white disabled:opacity-40 active:scale-95 transition-transform"
              >
                Anterior
              </button>
              <button
                type="button"
                disabled={historyPage >= historyTotalPages}
                onClick={() => fetchPayments(historyPage + 1)}
                className="px-3 py-1.5 text-xs rounded border bg-white disabled:opacity-40 active:scale-95 transition-transform"
              >
                Siguiente
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── RANK TAB ───────────────────────────────── */}
      <div className={`${mobileTab !== 'RANK' ? 'hidden' : 'tab-panel-enter'} md:block`}>
        <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-100 mb-6">
          <h3 className="text-lg font-bold mb-4 flex items-center gap-2 text-slate-800">
            <Trophy className="w-5 h-5 text-yellow-500" /> Ranking de Desempeño
          </h3>
          <p className="text-sm text-gray-500 mb-6">Comparativa de cobros registrados en el mes actual y ya aprobados entre todos los cobradores.</p>

          {!kpis || !kpis.byCollector || kpis.byCollector.length === 0 ? (
            <div className="py-12 text-center text-gray-400">Cargando ranking del mes...</div>
          ) : (
            <div className="space-y-8">
              {/* Chart container */}
              <CompactBarChart
                rows={(kpis.byCollector || []).map((r: any) => ({
                  key: String(r.userId || r.username || r.name),
                  label: (r.name || r.username || 'Cobrador').toString(),
                  values: [Number(r.sumApproved || 0)],
                  valueLabel: `${new Intl.NumberFormat('es-PY', { style: 'currency', currency: 'PYG', maximumFractionDigits: 0 }).format(Number(r.sumApproved || 0))} · ${Number(r.approved || 0)} aprob.`,
                  highlight: r.userId === user.id,
                }))}
                seriesColors={['#3b82f6']}
                maxItems={10}
              />

              {/* Leaderboard list */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {(kpis.byCollector || []).slice(0, 4).map((r: any, idx: number) => (
                  <div key={r.userId} className={`p-4 rounded-xl border flex items-center justify-between ${r.userId === user.id ? 'bg-blue-50 border-blue-200' : 'bg-slate-50 border-slate-100'}`}>
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${idx === 0 ? 'bg-yellow-100 text-yellow-700' : idx === 1 ? 'bg-slate-200 text-slate-600' : 'bg-orange-100 text-orange-700'}`}>
                        {idx + 1}
                      </div>
                      <div>
                        <div className="text-sm font-bold text-slate-800">{r.name || r.username} {r.userId === user.id && '(Vos)'}</div>
                        <div className="text-[11px] text-gray-500">{r.approved} consultas aprobadas</div>
                      </div>
                    </div>
                    <div className="text-sm font-black text-blue-600">
                      {new Intl.NumberFormat('es-PY', { style: 'currency', currency: 'PYG', maximumFractionDigits: 0 }).format(r.sumApproved)}
                    </div>
                  </div>
                ))}
              </div>

              <div className="bg-yellow-50 p-4 rounded-lg border border-yellow-100 flex items-start gap-3">
                <Trophy className="w-5 h-5 text-yellow-600 shrink-0 mt-0.5" />
                <div className="text-xs text-yellow-800 leading-relaxed">
                  <strong>¡Buen trabajo equipo!</strong> El ranking se actualiza cada 30 segundos. Seguí procesando transferencias para subir de posición.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Bottom Navigation for Mobile ────────────── */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur-md border-t border-gray-200 z-50 pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_12px_-2px_rgb(0,0,0,0.08)]">
        <div className="flex justify-around items-center h-16">
          <button
            type="button"
            onClick={() => switchTab('NEW')}
            className={`relative flex flex-col items-center justify-center w-full h-full space-y-1 transition-colors ${mobileTab === 'NEW' ? 'text-blue-600' : 'text-gray-400 active:text-gray-600'}`}
          >
            <Upload className="w-5 h-5" />
            <span className="text-[10px] font-semibold">Cobro</span>
            {mobileTab === 'NEW' && <span className="absolute bottom-0 w-6 h-[3px] bg-blue-600 rounded-t-full" />}
          </button>

          <button
            type="button"
            onClick={() => switchTab('LIST')}
            className={`relative flex flex-col items-center justify-center w-full h-full space-y-1 transition-colors ${mobileTab === 'LIST' ? 'text-blue-600' : 'text-gray-400 active:text-gray-600'}`}
          >
            <div className="relative">
              <FileText className="w-5 h-5" />
              {pendingCount > 0 && (
                <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 bg-amber-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center px-1">
                  {pendingCount > 99 ? '99+' : pendingCount}
                </span>
              )}
            </div>
            <span className="text-[10px] font-semibold">Mis pagos</span>
            {mobileTab === 'LIST' && <span className="absolute bottom-0 w-6 h-[3px] bg-blue-600 rounded-t-full" />}
          </button>

          <button
            type="button"
            onClick={() => switchTab('RANK')}
            className={`relative flex flex-col items-center justify-center w-full h-full space-y-1 transition-colors ${mobileTab === 'RANK' ? 'text-blue-600' : 'text-gray-400 active:text-gray-600'}`}
          >
            <Trophy className="w-5 h-5" />
            <span className="text-[10px] font-semibold">Ranking</span>
            {mobileTab === 'RANK' && <span className="absolute bottom-0 w-6 h-[3px] bg-blue-600 rounded-t-full" />}
          </button>
        </div>
      </div>
    </div>
  );
};
