import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, Check, Image as ImageIcon, Link2, Loader2, Search, X } from 'lucide-react';
import {
  BankFeedStatus,
  BankReceipt,
  BankTransfer,
  BankTransferStatus,
  CandidatePayment,
  ClaimToReview,
  MatchAssessment,
  Payment,
  PaymentState,
  User,
  UserRole,
} from '../types';
import { createRealtimeSocket, trackBankPanelDemand } from '../services/realtime';
import { feedChangedSince, readBankFeedSnapshot, withClockOffset } from '../services/bank-refresh';
import {
  apiErrorMessage,
  fetchBankFeedStatus,
  fetchBankMatchesForPayment,
  fetchBankTransfer,
  fetchBankTransfersPage,
  fetchCandidatePayments,
  fetchClaimsToReview,
  markClaimReviewed,
  fetchMyClaimsByMonth,
  newOperationKey,
  openBankReceipt,
  openReconciliationReceipt,
  reconcileBankTransfer,
  upsertBankTransfer,
} from '../services/bankTransfers';
import { TransferDetailModal } from '../components/bank/TransferDetailModal';
import { ProofViewer } from '../components/ProofViewer';
import { BankRefreshButton } from '../components/bank/BankRefreshButton';
import { MyClaimsList } from '../components/bank/MyClaimsList';
import { ownClaimRows } from '../services/my-bank-claims';
import { fetchPaymentsPage } from '../services/payments';
import { canUseApiFlow, destinationLabel } from '../services/payment-destination';
import { registerAndDisplayReceipt } from '../services/receipt-registration';
import { MatchBadge, formatDateTime, formatMoney, formatTime, toDate, FeedPill, feedFreshness } from '../components/bank/bankUi';
import { currentMonthKey, monthKeyOf, monthLabel } from '../services/bank-month';

const PENDING_STATES = [PaymentState.PENDIENTE_VERIFICACION, PaymentState.EN_REVISION];

const pendingOf = (p: Payment) => Math.max(0, Number(p.amount) - Number(p.allocatedAmount ?? 0));

/** Transferencia con saldo libre, que es lo unico conciliable. */
const isOpen = (t: BankTransfer) =>
  t.availableAmount > 0 && t.status !== BankTransferStatus.REVERSADA && t.status !== BankTransferStatus.BLOQUEADA;

/**
 * Conciliacion en un solo modulo: las consultas de los cobradores a la izquierda y lo que entro
 * por la API del banco a la derecha, para cotejar sin cambiar de pantalla.
 * Se elige de un lado, el otro se ordena por evidencia, y recien despues se confirma: conciliar
 * aprueba plata y bloquea la transferencia, asi que no puede depender de un clic suelto.
 */
export const ReconciliationView = ({
  user,
  showToast,
  onPrint,
}: {
  user: User;
  showToast: (t: 'success' | 'error' | 'info', m: string) => void;
  onPrint: (receipt: BankReceipt) => void;
}) => {
  const isAdmin = user.role === UserRole.ADMIN;
  // El supervisor mira todo pero no concilia (decision del 2026-10-07).
  const isSupervisor = user.role === UserRole.SUPERVISOR;
  const isCollector = user.role === UserRole.COBRADOR;
  const readOnly = isSupervisor;
  // El cobrador no tiene "Transferencias": su historial de conciliaciones vive aca.
  const [tab, setTab] = useState<'CONCILIAR' | 'MIAS'>('CONCILIAR');
  const [myClaims, setMyClaims] = useState<BankTransfer[]>([]);
  const [myClaimsLoading, setMyClaimsLoading] = useState(false);
  const [myClaimsError, setMyClaimsError] = useState<string | null>(null);
  const [myClaimsDate, setMyClaimsDate] = useState<string | null>(null);
  const myClaimsRequest = useRef(0);
  const [feed, setFeed] = useState<BankFeedStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  const loadRequest = useRef(0);
  const hasConnected = useRef(false);
  // Por mes: lo que entró ayer y nadie concilió sigue a la vista.
  const [month, setMonth] = useState(currentMonthKey());
  const [pendingOtherMonths, setPendingOtherMonths] = useState<Array<{ month: string; count: number }>>([]);
  const [transfersTotal, setTransfersTotal] = useState(0);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [transfers, setTransfers] = useState<BankTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [onlyOpen, setOnlyOpen] = useState(true);

  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [transferId, setTransferId] = useState<string | null>(null);
  // Evidencia calculada por el servidor para el lado que no se eligio, y de que lado esta.
  const [matches, setMatches] = useState<Record<string, MatchAssessment> | null>(null);
  const [scoredSide, setScoredSide] = useState<'TRANSFERS' | 'PAYMENTS' | null>(null);
  const [scoring, setScoring] = useState(false);
  // Mientras se arma una pareja, lo que entra espera aca: si la fila se mueve, se clickea otra cosa.
  const [held, setHeld] = useState<BankTransfer[]>([]);
  // Contrapeso de que el cobrador cierre lo suyo: el admin ve lo que se cerro y con que respaldo.
  const [review, setReview] = useState<ClaimToReview[]>([]);
  const [showReview, setShowReview] = useState(false);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  // Conciliación de la cola abierta lado a lado: comprobante del cobrador y transferencia del banco.
  const [proofClaim, setProofClaim] = useState<ClaimToReview | null>(null);
  const [inspect, setInspect] = useState<BankTransfer | null>(null);
  const [pendingPrints, setPendingPrints] = useState<Array<{ transferId: string; paymentId: string; label: string }>>([]);
  const [retryingPrintId, setRetryingPrintId] = useState<string | null>(null);

  const monthRef = useRef(month);
  monthRef.current = month;
  const onlyOpenRef = useRef(onlyOpen);
  onlyOpenRef.current = onlyOpen;
  const pairingRef = useRef(false);
  pairingRef.current = !!paymentId || !!transferId;
  const changeCount = useRef<number | null>(null);
  const deferredFeedReload = useRef(false);

  /** Guarda el estado del feed; devuelve true si el servidor registró algo que hay que releer. */
  const applyFeed = useCallback((status: BankFeedStatus) => {
    const changed = feedChangedSince(changeCount.current, status.changeCount);
    if (typeof status.changeCount === 'number') changeCount.current = status.changeCount;
    setFeed(withClockOffset(status));
    return changed;
  }, []);

  const load = useCallback(async () => {
    // Una respuesta vieja (otra fecha, o una recarga anterior) no pisa lo que se esta mirando.
    const request = ++loadRequest.current;
    try {
      const requestedMonth = monthRef.current;
      const [page, { list, status }] = await Promise.all([
        fetchPaymentsPage({ statuses: PENDING_STATES, pageSize: 100, globalScope: isAdmin || isSupervisor, isAtlasAccount: true }),
        readBankFeedSnapshot(
          () => fetchBankFeedStatus().catch(() => null),
          // "Solo abiertas" trae todas las sin tomar del mes; sin ese filtro, las 200 más recientes.
          () => fetchBankTransfersPage({ month: requestedMonth, view: onlyOpenRef.current ? 'DISPONIBLES' : 'TODAS', pageSize: 200 }),
        ),
      ]);
      if (request !== loadRequest.current) return;
      setPayments(page.items);
      setTransfers(list.items);
      setTransfersTotal(list.total);
      setPendingOtherMonths(list.pendingOtherMonths.filter((m) => m.month !== requestedMonth));
      if (status) applyFeed(status);
      setHeld([]);
      if (isAdmin) {
        const queue = await fetchClaimsToReview({ days: 7 });
        if (request === loadRequest.current) setReview(queue);
      }
    } catch (e) {
      if (request === loadRequest.current) showToast('error', apiErrorMessage(e, 'No se pudo cargar la conciliación.'));
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }, [applyFeed, isAdmin, isSupervisor, showToast]);

  useEffect(() => {
    if (!paymentId && !transferId && deferredFeedReload.current) {
      deferredFeedReload.current = false;
      void load();
    }
  }, [paymentId, transferId, load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  /** "Mis conciliadas" de la fecha elegida (fecha de la conciliacion, incluidas las anuladas). */
  const loadMyClaims = useCallback(async () => {
    const request = ++myClaimsRequest.current;
    const requested = monthRef.current;
    setMyClaimsLoading(true);
    setMyClaimsError(null);
    try {
      const list = await fetchMyClaimsByMonth(requested);
      if (request === myClaimsRequest.current) {
        setMyClaims(list);
        setMyClaimsDate(requested);
      }
    } catch (e) {
      if (request === myClaimsRequest.current) {
        setMyClaims([]);
        setMyClaimsError(apiErrorMessage(e, 'No se pudieron cargar tus conciliaciones.'));
        setMyClaimsDate(requested);
      }
    } finally {
      if (request === myClaimsRequest.current) setMyClaimsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'MIAS') void loadMyClaims();
  }, [tab, month, loadMyClaims]);

  const reprintOwn = async (transfer: BankTransfer, claimId: string) => {
    try {
      // El contador de impresiones se actualiza cuando la persona confirma que salió.
      onPrint(await openBankReceipt(transfer.id, claimId));
    } catch (e) {
      showToast('error', apiErrorMessage(e, 'No se pudo reimprimir el comprobante.'));
    }
  };

  const ownRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ownClaimRows(myClaims, user.id).filter(({ transfer, claim }) =>
      !q ||
      [claim.receiptNumber, claim.referenceValue, claim.paymentRef, claim.clientName, transfer.senderName, String(claim.amount)]
        .some((value) => value?.toLowerCase().includes(q)),
    );
  }, [myClaims, search, user.id]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [month, onlyOpen, load]);

  useEffect(() => {
    const socket = createRealtimeSocket();
    const sameMonth = (t: BankTransfer) => monthKeyOf(toDate(t.movementAt)) === monthRef.current;
    const incoming = (t: BankTransfer) => {
      if (!sameMonth(t)) return;
      // Con una pareja a medio armar, la lista no se mueve sola.
      if (pairingRef.current) setHeld((prev) => upsertBankTransfer(prev, t));
      else setTransfers((prev) => upsertBankTransfer(prev, t));
    };
    socket.on('bank-transfers:new', incoming);
    socket.on('bank-transfers:updated', (t: BankTransfer) => {
      setTransfers((prev) => (prev.some((x) => x.id === t.id) ? upsertBankTransfer(prev, t) : prev));
      if (!pairingRef.current) incoming(t);
    });
    // Con una pareja a medio armar la relectura espera a que se concilie o se suelte la selección.
    const reloadUnlessPairing = () => {
      if (pairingRef.current) deferredFeedReload.current = true;
      else void load();
    };
    // Si el servidor registró transferencias y el aviso de alguna no llegó, se relee la lista.
    socket.on('bank-feed:status', (status: BankFeedStatus) => {
      if (applyFeed(status)) reloadUnlessPairing();
    });
    socket.on('connect', () => {
      setConnected(true);
      // Tras un corte se recarga: pudieron entrar transferencias o cerrarse consultas.
      if (hasConnected.current) reloadUnlessPairing();
      hasConnected.current = true;
    });
    socket.on('disconnect', () => setConnected(false));

    // Respaldo si el tiempo real se cae: una lectura por minuto, solo con la pestana visible.
    const fallback = setInterval(() => {
      if (!socket.connected && document.visibilityState === 'visible') reloadUnlessPairing();
    }, 60_000);
    // El banco solo se consulta mientras este modulo este abierto y visible.
    const stopDemand = trackBankPanelDemand(socket, reloadUnlessPairing);
    return () => {
      clearInterval(fallback);
      stopDemand();
      socket.disconnect();
    };
  }, [applyFeed, load]);

  /** El admin la revisó y está bien: sale de la cola, sin anular nada. */
  const markReviewed = async (c: ClaimToReview) => {
    setReviewingId(c.id);
    try {
      await markClaimReviewed(c.transferId, c.id);
      setReview((prev) => prev.filter((item) => item.id !== c.id));
      setProofClaim((open) => (open?.id === c.id ? null : open));
      showToast('success', `Conciliación ${c.receiptNumber} marcada como revisada.`);
    } catch (e) {
      showToast('error', apiErrorMessage(e, 'No se pudo marcar como revisada.'));
    } finally {
      setReviewingId(null);
    }
  };

  const releaseHeld = () => {
    setTransfers((prev) => held.reduce((acc, t) => upsertBankTransfer(acc, t), prev));
    setHeld([]);
  };

  const clearPair = () => {
    setPaymentId(null);
    setTransferId(null);
    setMatches(null);
    setScoredSide(null);
  };

  /** Al elegir un lado, el servidor dice que tan bien calza cada candidato del otro lado. */
  const selectPayment = async (id: string) => {
    if (paymentId === id) return clearPair();
    if (!canUseApiFlow(payments.find((item) => item.id === id)?.isAtlasAccount)) {
      showToast('info', 'Esta consulta no es una cuenta Atlas clasificada. Usá revisión manual o clasificá el histórico.');
      return;
    }
    setPaymentId(id);
    setMatches(null);
    setScoredSide('TRANSFERS');
    setScoring(true);
    try {
      const candidates = await fetchBankMatchesForPayment(id);
      setMatches(Object.fromEntries(candidates.filter((c) => c.match).map((c) => [c.id, c.match!])));
      setTransfers((prev) => prev.map((t) => candidates.find((c) => c.id === t.id) ?? t));
      if (transferId && !candidates.some((c) => c.id === transferId)) setTransferId(null);
    } catch (e) {
      showToast('error', apiErrorMessage(e, 'No se pudieron buscar las transferencias que calzan.'));
    } finally {
      setScoring(false);
    }
  };

  const selectTransfer = async (id: string) => {
    if (transferId === id) return clearPair();
    setTransferId(id);
    setMatches(null);
    setScoredSide('PAYMENTS');
    setScoring(true);
    try {
      const candidates = await fetchCandidatePayments(id);
      const atlasCandidates = candidates.filter((candidate) => canUseApiFlow(candidate.isAtlasAccount));
      setMatches(Object.fromEntries(atlasCandidates.filter((c) => c.match).map((c) => [c.id, c.match!])));
      // Las candidatas del servidor pueden no estar en la pagina cargada: se agregan.
      setPayments((prev) => {
        const known = new Set(prev.map((p) => p.id));
        const extra = atlasCandidates
          .filter((c) => !known.has(c.id))
          .map<Payment>((c) => ({
            id: c.id,
            amount: c.amount,
            allocatedAmount: c.allocatedAmount,
            currency: 'PYG',
            clientName: c.clientName ?? undefined,
            clientCode: c.clientCode ?? undefined,
            paymentRef: c.paymentRef ?? undefined,
            sourceBank: c.sourceBank ?? undefined,
            isAtlasAccount: c.isAtlasAccount ?? null,
            status: c.status,
            createdAt: c.createdAt,
            createdById: c.collectorId,
            createdBy: { id: c.collectorId, name: c.collectorName ?? '', username: c.collectorName ?? '' } as any,
          }));
        return [...prev, ...extra];
      });
    } catch (e) {
      showToast('error', apiErrorMessage(e, 'No se pudieron buscar las consultas que calzan.'));
    } finally {
      setScoring(false);
    }
  };

  const payment = payments.find((p) => p.id === paymentId) ?? null;
  const transfer = transfers.find((t) => t.id === transferId) ?? null;

  const visiblePayments = useMemo(() => {
    const q = search.trim().toLowerCase();
    return payments
      .filter((p) => canUseApiFlow(p.isAtlasAccount))
      .filter((p) => (onlyOpen ? pendingOf(p) > 0 : true))
      .filter((p) =>
        !q
          ? true
          : [p.clientName, p.clientCode, p.paymentRef, String(p.amount)].filter(Boolean).join(' ').toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const byMatch = (matches?.[b.id]?.score ?? -1) - (matches?.[a.id]?.score ?? -1);
        return byMatch !== 0 ? byMatch : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
  }, [matches, onlyOpen, payments, search]);

  const visibleTransfers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return transfers
      .filter((t) => (onlyOpen ? isOpen(t) : true))
      .filter((t) =>
        !q ? true : [t.senderName, t.senderNote, t.bankDocNumber, String(t.amount)].filter(Boolean).join(' ').toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const byMatch = (matches?.[b.id]?.score ?? -1) - (matches?.[a.id]?.score ?? -1);
        return byMatch !== 0 ? byMatch : toDate(b.movementAt).getTime() - toDate(a.movementAt).getTime();
      });
  }, [matches, onlyOpen, search, transfers]);

  // La evidencia esta indexada por el lado que NO se eligio primero.
  const pairMatch = payment && transfer ? matches?.[scoredSide === 'TRANSFERS' ? transfer.id : payment.id] : undefined;
  const applied = payment && transfer ? Math.min(transfer.availableAmount, pendingOf(payment)) : 0;
  const covers = !!payment && applied >= pendingOf(payment);

  const confirm = async () => {
    if (readOnly || !payment || !transfer || busy) return;
    setMyClaimsDate(null);
    if (!canUseApiFlow(payment.isAtlasAccount)) {
      showToast('info', 'Solo las consultas de cuenta Atlas pueden conciliarse con el feed bancario.');
      return;
    }
    setBusy(true);
    try {
      const updated = await reconcileBankTransfer(transfer.id, payment.id, newOperationKey());
      setTransfers((prev) => upsertBankTransfer(prev, updated));
      setPayments((prev) =>
        prev
          .map((p) => (p.id === payment.id ? { ...p, allocatedAmount: Number(p.allocatedAmount ?? 0) + applied } : p))
          .filter((p) => (onlyOpen ? pendingOf(p) > 0 : true)),
      );
      showToast(
        'success',
        covers
          ? `Consulta ${payment.paymentRef || payment.clientName || ''} conciliada y aprobada.`
          : `Se aplicaron ${formatMoney(applied)} a la consulta. Le siguen faltando ${formatMoney(pendingOf(payment) - applied)}.`,
      );
      // El comprobante solo se abre si el backend registró su impresión.
      try {
        await registerAndDisplayReceipt(() => openReconciliationReceipt(updated, payment.id), onPrint);
      } catch (error) {
        setPendingPrints((prev) => [...prev.filter((item) => item.paymentId !== payment.id || item.transferId !== transfer.id), {
          transferId: transfer.id,
          paymentId: payment.id,
          label: payment.paymentRef || payment.clientName || payment.id.slice(0, 8),
        }]);
        showToast('error', `Conciliación registrada, pero no se pudo abrir el comprobante: ${apiErrorMessage(error, 'reintentá aquí o desde Mis conciliadas')}.`);
      }
      clearPair();
      releaseHeld();
    } catch (e) {
      showToast('error', apiErrorMessage(e, 'No se pudo conciliar.'));
      void load();
    } finally {
      setBusy(false);
    }
  };

  const retryPendingPrint = async (item: { transferId: string; paymentId: string }) => {
    setRetryingPrintId(item.paymentId);
    try {
      const current = await fetchBankTransfer(item.transferId);
      await registerAndDisplayReceipt(() => openReconciliationReceipt(current, item.paymentId), onPrint);
      setPendingPrints((prev) => prev.filter((pending) => pending.paymentId !== item.paymentId || pending.transferId !== item.transferId));
    } catch (error) {
      showToast('error', apiErrorMessage(error, 'No se pudo abrir el comprobante. La conciliación sigue guardada.'));
    } finally {
      setRetryingPrintId(null);
    }
  };

  return (
    <div className="space-y-4">
      {pendingPrints.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="alert">
          <p className="font-bold">Conciliación guardada; el comprobante no se pudo abrir.</p>
          <p className="mt-1">No entregues nada hasta imprimirlo. También podés imprimirlo desde {isCollector ? '«Mis conciliadas»' : 'Transferencias recibidas'}.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {pendingPrints.map((item) => (
              <button key={`${item.transferId}:${item.paymentId}`} type="button" onClick={() => void retryPendingPrint(item)} disabled={retryingPrintId !== null} className="rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">
                {retryingPrintId === item.paymentId ? 'Abriendo…' : `Imprimir · ${item.label}`}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Conciliación</h2>
          <p className="text-sm text-slate-500">
            {readOnly
              ? 'Consultas de los cobradores a la izquierda y lo que entró por el banco a la derecha. Vista de solo lectura: podés ver qué calza, pero concilian el admin y el cobrador dueño de la consulta.'
              : isAdmin
                ? 'Consultas de los cobradores a la izquierda, lo que entró por el banco a la derecha. Elegí de un lado y el otro se ordena por la evidencia que los une.'
                : 'Tus consultas a la izquierda y lo que entró por el banco a la derecha. Elegí las dos y confirmá.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(() => {
            const freshness = feedFreshness(feed, now);
            return <FeedPill label={connected ? freshness.label : 'Reconectando…'} tone={connected ? freshness.tone : 'amber'} mock={feed?.mode === 'mock'} />;
          })()}
          <input
            type="month"
            value={month}
            max={currentMonthKey()}
            onChange={(e) => /^\d{4}-\d{2}$/.test(e.target.value) && setMonth(e.target.value)}
            aria-label="Mes"
            className="p-2 border rounded-lg text-sm"
          />
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-slate-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Cliente, ref, monto…" className="w-48 pl-8 pr-2 py-2 border rounded-lg text-sm" />
          </div>
          <BankRefreshButton status={feed} onStatus={applyFeed} showToast={showToast} onReload={tab === 'MIAS' ? loadMyClaims : load} />
        </div>
      </div>

      {isCollector && (
        <div className="flex gap-1 bg-slate-100 p-1 rounded-xl w-fit">
          {([
            ['CONCILIAR', 'Por conciliar'],
            ['MIAS', 'Mis conciliadas'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${tab === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {(pendingOtherMonths.length > 0 || transfersTotal > transfers.length) && (
        <div className="flex flex-wrap items-center gap-2 p-3 rounded-xl border border-sky-200 bg-sky-50 text-xs text-sky-900" role="status">
          {pendingOtherMonths.length > 0 && <span className="font-semibold">Sin conciliar en otros meses:</span>}
          {pendingOtherMonths.map((m) => (
            <button key={m.month} type="button" onClick={() => setMonth(m.month)} className="px-2.5 py-1 rounded-lg bg-white border border-sky-300 font-bold hover:bg-sky-100">
              {monthLabel(m.month)} ({m.count}) · ver
            </button>
          ))}
          {transfersTotal > transfers.length && (
            <span>Se muestran las {transfers.length} más recientes de {transfersTotal}; usá la búsqueda o «Solo abiertas».</span>
          )}
        </div>
      )}

      {tab === 'MIAS' ? (
        <MyClaimsList
          rows={ownRows}
          userId={user.id}
          role={user.role}
          loading={myClaimsLoading || myClaimsDate !== month}
          error={myClaimsError}
          onRetry={() => void loadMyClaims()}
          onReprint={(t, claimId) => void reprintOwn(t, claimId)}
          noun="conciliaciones"
        />
      ) : (
      <>
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600">
          <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} className="rounded" />
          Mostrar solo lo que falta conciliar
        </label>
        {held.length > 0 && (
          <button type="button" onClick={releaseHeld} className="px-3 py-1 rounded-full bg-emerald-600 text-white text-xs font-bold">
            {held.length} {held.length === 1 ? 'transferencia nueva' : 'transferencias nuevas'} · mostrar
          </button>
        )}
        {isAdmin && review.length > 0 && (
          <button
            type="button"
            onClick={() => setShowReview((v) => !v)}
            className="px-3 py-1 rounded-full border border-amber-300 bg-amber-50 text-amber-900 text-xs font-bold"
          >
            {review.length} {review.length === 1 ? 'conciliación para revisar' : 'conciliaciones para revisar'}
          </button>
        )}
        {scoring && (
          <span className="inline-flex items-center gap-1 text-xs text-slate-500">
            <Loader2 className="w-3 h-3 animate-spin" /> Buscando coincidencias…
          </span>
        )}
      </div>

      {isAdmin && showReview && (
        <div className="bg-white border border-amber-300 rounded-xl overflow-hidden">
          <header className="px-4 py-2 border-b bg-amber-50">
            <h3 className="text-sm font-bold text-amber-900">Cerradas por cobradores o sin evidencia (7 días)</h3>
            <p className="text-[11px] text-amber-800">Abrí una para ver el detalle. Si está bien, marcala como revisada; si no corresponde, anulala desde el detalle.</p>
          </header>
          <ul className="max-h-64 overflow-y-auto divide-y">
            {review.map((c) => (
              <li key={c.id} className="flex items-stretch">
                <button
                  type="button"
                  onClick={() =>
                    fetchBankTransfer(c.transferId)
                      .then(setInspect)
                      .catch((e) => showToast('error', apiErrorMessage(e, 'No se pudo abrir la transferencia.')))
                  }
                  className="min-w-0 flex-1 text-left px-4 py-2 hover:bg-amber-50/60"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-bold text-slate-800">
                      {formatMoney(c.amount)} · {c.clientName || c.paymentRef || c.referenceValue}
                    </span>
                    <span className={`text-[10px] font-bold ${c.matchStrength === 'DEBIL' ? 'text-amber-700' : 'text-slate-500'}`}>
                      {c.matchStrength === 'DEBIL' ? 'SIN EVIDENCIA' : c.matchStrength}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500">
                    {c.claimedByName || c.claimedByUsername} ({c.claimedByRole.toLowerCase()}) · {formatDateTime(c.claimedAt)} · {c.receiptNumber}
                    {c.clientCode ? ` · cód. ${c.clientCode}` : ''}
                    {c.senderName ? ` · de ${c.senderName}` : ''}
                  </div>
                </button>
                {c.paymentId && (
                  <button
                    type="button"
                    onClick={() => setProofClaim((open) => (open?.id === c.id ? null : c))}
                    aria-pressed={proofClaim?.id === c.id}
                    title="Ver la imagen que subió el cobrador junto a la transferencia del banco"
                    className={`shrink-0 my-2 inline-flex items-center gap-1 rounded-lg border px-3 text-xs font-bold ${proofClaim?.id === c.id ? 'border-sky-500 bg-sky-100 text-sky-900' : 'border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100'}`}
                  >
                    <ImageIcon className="w-3.5 h-3.5" /> Ver comprobante
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void markReviewed(c)}
                  disabled={reviewingId !== null}
                  title="Está bien: sale de esta lista sin anular nada"
                  className="shrink-0 m-2 inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-emerald-50 px-3 text-xs font-bold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                >
                  {reviewingId === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Revisada
                </button>
              </li>
            ))}
          </ul>
          {proofClaim && (
            <div className="border-t border-amber-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between gap-2 mb-3">
                <h4 className="text-sm font-bold text-slate-800">
                  Revisar {proofClaim.receiptNumber}: lo que subió el cobrador contra lo que entró al banco
                </h4>
                <button type="button" onClick={() => setProofClaim(null)} aria-label="Cerrar comparación" className="p-1 rounded-lg text-slate-500 hover:bg-slate-200">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <section>
                  <p className="text-xs font-bold text-slate-500 uppercase mb-2">Comprobante del cobrador</p>
                  <ProofViewer paymentId={proofClaim.paymentId} />
                </section>
                <section className="space-y-3 text-sm">
                  <div className="rounded-lg border bg-white p-3">
                    <p className="text-xs font-bold text-slate-500 uppercase mb-1">Transferencia del banco</p>
                    <p className="text-lg font-black text-slate-900">{formatMoney(proofClaim.transferAmount)}</p>
                    <p>Remitente: <b>{proofClaim.senderName || 'no informado'}</b></p>
                    <p>Documento del banco: <b>{proofClaim.bankDocNumber || '—'}</b></p>
                    {proofClaim.movementAt && <p>Ingresó: <b>{formatDateTime(proofClaim.movementAt)}</b></p>}
                  </div>
                  <div className="rounded-lg border bg-white p-3">
                    <p className="text-xs font-bold text-slate-500 uppercase mb-1">Consulta del cobrador</p>
                    <p className="text-lg font-black text-slate-900">{formatMoney(proofClaim.amount)}</p>
                    <p>Cód. cliente: <b>{proofClaim.clientCode || '—'}</b>{proofClaim.clientName ? ` · ${proofClaim.clientName}` : ''}</p>
                    <p>Referencia: <b>{proofClaim.paymentRef || '—'}</b></p>
                    <p>
                      Concilió: <b>{proofClaim.claimedByName || proofClaim.claimedByUsername}</b> · {formatDateTime(proofClaim.claimedAt)} ·{' '}
                      <span className={proofClaim.matchStrength === 'DEBIL' ? 'font-bold text-amber-700' : ''}>
                        {proofClaim.matchStrength === 'DEBIL' ? 'sin evidencia' : `evidencia ${String(proofClaim.matchStrength ?? '').toLowerCase()}`}
                      </span>
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void markReviewed(proofClaim)}
                      disabled={reviewingId !== null}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {reviewingId === proofClaim.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Revisada, está bien
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        fetchBankTransfer(proofClaim.transferId)
                          .then(setInspect)
                          .catch((e) => showToast('error', apiErrorMessage(e, 'No se pudo abrir la transferencia.')))
                      }
                      className="rounded-lg border bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100"
                    >
                      Abrir detalle / anular
                    </button>
                  </div>
                </section>
              </div>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center p-10 text-slate-500">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* ---------------------------------------------- consultas */}
          <section className="bg-white border rounded-xl overflow-hidden">
            <header className="px-4 py-2 border-b bg-slate-50 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-700">{isAdmin || isSupervisor ? 'Consultas Atlas por conciliar' : 'Mis consultas Atlas'}</h3>
              <span className="text-xs text-slate-500">{visiblePayments.length}</span>
            </header>
            <ul className="max-h-[60vh] overflow-y-auto divide-y">
              {visiblePayments.length === 0 && <li className="p-6 text-center text-sm text-slate-500">No hay consultas Atlas pendientes.</li>}
              {visiblePayments.map((p) => {
                const match = matches?.[p.id];
                const selected = p.id === paymentId;
                const pending = pendingOf(p);
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => void selectPayment(p.id)}
                      className={`w-full text-left px-4 py-2.5 transition ${selected ? 'bg-indigo-50 border-l-4 border-indigo-600' : 'hover:bg-slate-50 border-l-4 border-transparent'}`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-black text-slate-900">{formatMoney(p.amount, p.currency)}</span>
                        <div className="flex items-center gap-2">
                          {match && <MatchBadge match={match} />}
                          {selected && <Check className="w-4 h-4 text-indigo-600" />}
                        </div>
                      </div>
                      <div className="text-xs text-slate-600 truncate">
                        {p.clientName || 'Cliente'} · Cód. {p.clientCode || '--'} · Ref {p.paymentRef || '--'} · Origen {p.sourceBank || 'no informado'}
                      </div>
                      <div className="text-[11px] font-semibold text-slate-600">Destino: {destinationLabel(p.isAtlasAccount)}</div>
                      <div className="text-[11px] text-slate-400">
                        {formatDateTime(p.createdAt)}
                        {p.createdBy ? ` · ${p.createdBy.name || p.createdBy.username}` : ''}
                        {pending !== Number(p.amount) ? ` · falta ${formatMoney(pending, p.currency)}` : ''}
                      </div>
                      {match?.reason && <p className="mt-1 text-[11px] text-slate-600">{match.reason}</p>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* ------------------------------------------ transferencias */}
          <section className="bg-white border rounded-xl overflow-hidden">
            <header className="px-4 py-2 border-b bg-slate-50 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-700">Transferencias del banco</h3>
              <span className="text-xs text-slate-500">{visibleTransfers.length}</span>
            </header>
            <ul className="max-h-[60vh] overflow-y-auto divide-y">
              {visibleTransfers.length === 0 && <li className="p-6 text-center text-sm text-slate-500">No hay transferencias con saldo ese día.</li>}
              {visibleTransfers.map((t) => {
                const match = matches?.[t.id];
                const selected = t.id === transferId;
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => void selectTransfer(t.id)}
                      className={`w-full text-left px-4 py-2.5 transition ${selected ? 'bg-emerald-50 border-l-4 border-emerald-600' : 'hover:bg-slate-50 border-l-4 border-transparent'}`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-black text-slate-900">{formatMoney(t.availableAmount, t.currency)}</span>
                        <div className="flex items-center gap-2">
                          {t.availableAmount !== t.amount && (
                            <span className="text-[10px] font-bold text-sky-700">de {formatMoney(t.amount, t.currency)}</span>
                          )}
                          {match && <MatchBadge match={match} />}
                          {selected && <Check className="w-4 h-4 text-emerald-600" />}
                        </div>
                      </div>
                      <div className="text-xs text-slate-600 truncate">
                        {t.senderName || 'Remitente no informado'} · {t.senderBankName || 'Banco no informado'}
                      </div>
                      <div className="text-[11px] text-slate-400 truncate">
                        {formatDateTime(t.movementAt)} · ID {t.bankDocNumber || t.id.slice(0, 8)}
                        {t.senderNote ? ` · “${t.senderNote}”` : ''}
                      </div>
                      {match?.reason && <p className="mt-1 text-[11px] text-slate-600">{match.reason}</p>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      )}
      </>
      )}

      {inspect && (
        <TransferDetailModal
          transfer={inspect}
          user={user}
          onClose={() => setInspect(null)}
          onChanged={(t) => {
            setInspect(t);
            setTransfers((prev) => (prev.some((x) => x.id === t.id) ? upsertBankTransfer(prev, t) : prev));
            void load();
          }}
          onPrint={onPrint}
          showToast={showToast}
        />
      )}

      {/* Confirmacion: conciliar mueve plata, no puede ser un clic suelto sobre una lista viva. */}
      {(payment || transfer) && (
        <div className="sticky bottom-0 z-20 bg-white border-2 border-slate-800 rounded-xl shadow-xl p-3 space-y-2">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold text-slate-400 uppercase">Consulta</p>
              {payment ? (
                <p className="text-sm font-semibold text-slate-800 truncate">
                  {formatMoney(payment.amount, payment.currency)} · {payment.clientName || payment.clientCode || 'Cliente'} · Ref {payment.paymentRef || '--'}
                </p>
              ) : (
                <p className="text-sm text-slate-400">Elegí una consulta de la izquierda</p>
              )}
              {payment && <p className="text-[11px] text-slate-600">Destino: {destinationLabel(payment.isAtlasAccount)}</p>}
            </div>
            <ArrowRight className="w-5 h-5 text-slate-400 shrink-0 hidden sm:block" />
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold text-slate-400 uppercase">Transferencia</p>
              {transfer ? (
                <p className="text-sm font-semibold text-slate-800 truncate">
                  {formatMoney(transfer.availableAmount, transfer.currency)} · {transfer.senderName || 'Remitente'} · ID {transfer.bankDocNumber || transfer.id.slice(0, 8)}
                </p>
              ) : (
                <p className="text-sm text-slate-400">Elegí una transferencia de la derecha</p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button type="button" onClick={clearPair} aria-label="Quitar la selección de consulta y transferencia" className="px-3 py-2 rounded-lg border text-sm font-semibold text-slate-600">
                <X className="w-4 h-4" />
              </button>
              {readOnly ? (
                <span className="px-3 py-2 rounded-lg bg-slate-100 text-xs font-semibold text-slate-500">Solo lectura</span>
              ) : (
                <button
                  type="button"
                  onClick={() => void confirm()}
                  disabled={!payment || !transfer || busy}
                  className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-bold disabled:opacity-40 inline-flex items-center gap-2"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                  Conciliar
                </button>
              )}
            </div>
          </div>

          {payment && transfer && (
            <div className="text-xs text-slate-600 border-t pt-2">
              Se aplican <b>{formatMoney(applied, transfer.currency)}</b>.{' '}
              {covers ? 'La consulta queda aprobada.' : `A la consulta le seguirán faltando ${formatMoney(pendingOf(payment) - applied, transfer.currency)}.`}
              {pairMatch?.strength === 'DEBIL' && (
                <span className="ml-1 inline-flex items-center gap-1 text-amber-700 font-semibold">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {pairMatch.reason || 'Sin evidencia suficiente: mirá el comprobante antes de confirmar.'}
                </span>
              )}
              {pairMatch && pairMatch.strength !== 'DEBIL' && <span className="ml-1 text-emerald-700 font-semibold">{pairMatch.reason}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
