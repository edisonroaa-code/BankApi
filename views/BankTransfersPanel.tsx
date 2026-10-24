import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, Hand, Loader2, Printer, Search, SlidersHorizontal } from 'lucide-react';
import { BankFeedStatus, BankReceipt, BankTransfer, BankTransfersPage, BankTransferStatus, User, UserRole } from '../types';
import { createRealtimeSocket, trackBankPanelDemand } from '../services/realtime';
import { apiErrorMessage, fetchBankFeedStatus, fetchBankTransfersPage, fetchMyClaimsByMonth, openBankReceipt, resumeBankFeed, upsertBankTransfer } from '../services/bankTransfers';
import { currentMonthKey, formatDayTime, monthKeyOf, monthLabel, pageWindow } from '../services/bank-month';
import { canDirectlyClaimBankTransfer, isSupportedBankCurrency } from '../services/bank-claim-policy';
import { feedChangedSince, readBankFeedSnapshot, withClockOffset } from '../services/bank-refresh';
import { ownClaimRows, ownClaimsAffectedByTransfer } from '../services/my-bank-claims';
import {
  BankStatusBadge,
  claimSummary,
  claimsSummary,
  FeedPill,
  feedFreshness,
  formatDateTime,
  formatMoney,
  formatTime,
  roleLabel,
  statusStyle,
  todayKey,
  toDate,
  transferMatches,
} from '../components/bank/bankUi';
import { TakeTransferModal } from '../components/bank/TakeTransferModal';
import { AdminBalance } from '../components/bank/AdminBalance';
import { MyClaimsList } from '../components/bank/MyClaimsList';
import { canPrintClaim } from '../services/print-policy';
import { BankRefreshButton } from '../components/bank/BankRefreshButton';
import { TransferDetailModal } from '../components/bank/TransferDetailModal';

type Filter = 'DISPONIBLES' | 'TOMADAS' | 'MIAS' | 'REVISAR' | 'TODAS';

/** Lo que todavia se puede cobrar de una transferencia. */
const isOpen = (t: BankTransfer) =>
  t.availableAmount > 0 && t.status !== BankTransferStatus.REVERSADA && t.status !== BankTransferStatus.BLOQUEADA;

// Respaldo solo si el WebSocket se cae: en horario de caja la base ya esta activa por las tomas.
const FALLBACK_POLL_MS = 60 * 1000;
const FRESH_MS = 10 * 1000;
// Transferencias por página dentro del mes.
const PAGE_SIZE = 25;

/**
 * Panel de transferencias que ingresan por la API del banco.
 * - CAJERO: ve las del dia y toma una con doble clic (o el boton Tomar en pantallas tactiles).
 * - COBRADOR: ve las del dia y concilia contra sus propias consultas.
 * - ADMIN: ve cualquier dia, toma directamente, concilia con cualquier consulta, anula y libera.
 * No muestra saldos ni sumas de dinero de la cuenta: solo cantidades por estado.
 */
export const BankTransfersPanel = ({
  user,
  showToast,
  onPrint,
}: {
  user: User;
  showToast: (t: 'success' | 'error' | 'info', m: string) => void;
  onPrint: (receipt: BankReceipt) => void;
}) => {
  const isCashier = user.role === UserRole.CAJERO;
  const isAdmin = user.role === UserRole.ADMIN;
  const isCollector = user.role === UserRole.COBRADOR;
  // El supervisor solo mira (decision del 2026-10-07): ni toma, ni concilia, ni anula.
  const isSupervisor = user.role === UserRole.SUPERVISOR;
  const canDirectlyClaim = canDirectlyClaimBankTransfer(user.role);
  const [items, setItems] = useState<BankTransfer[]>([]);
  const [pageInfo, setPageInfo] = useState<Omit<BankTransfersPage, 'items'> | null>(null);
  const [page, setPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [myClaimItems, setMyClaimItems] = useState<BankTransfer[]>([]);
  const [myClaimsLoading, setMyClaimsLoading] = useState(false);
  const [myClaimsLoadedMonth, setMyClaimsLoadedMonth] = useState<string | null>(null);
  const [myClaimsError, setMyClaimsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [feed, setFeed] = useState<BankFeedStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [filter, setFilter] = useState<Filter>(isCashier ? 'DISPONIBLES' : 'TODAS');
  const [search, setSearch] = useState('');
  // El panel muestra un mes entero: lo que entró ayer y nadie tomó sigue a la vista.
  const [month, setMonth] = useState(currentMonthKey());
  const [fresh, setFresh] = useState<Record<string, number>>({});
  // Lo que está abierto (tomar, detalle) no depende de la página: si una relectura la saca de la
  // lista (entró otra y la empujó a la página siguiente, otro la tomó), el cuadro sigue abierto con
  // lo que se estaba escribiendo y solo se actualizan sus datos.
  const [taking, setTaking] = useState<BankTransfer | null>(null);
  const [detail, setDetail] = useState<BankTransfer | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(Date.now());
  const monthRef = useRef(month);
  monthRef.current = month;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const pageRef = useRef(page);
  pageRef.current = page;
  const searchRef = useRef(searchQuery);
  searchRef.current = searchQuery;
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const myClaimItemsRef = useRef(myClaimItems);
  myClaimItemsRef.current = myClaimItems;
  const myClaimsRequest = useRef(0);
  // Cada carga lleva numero: si cambia la fecha o llega una mas nueva, la respuesta vieja se descarta
  // en lugar de pisar la lista que el usuario esta mirando.
  const loadRequest = useRef(0);
  const hasConnected = useRef(false);
  const changeCount = useRef<number | null>(null);

  /** Guarda el estado del feed; devuelve true si el servidor registró algo que hay que releer. */
  const applyFeed = useCallback((status: BankFeedStatus) => {
    const changed = feedChangedSince(changeCount.current, status.changeCount);
    if (typeof status.changeCount === 'number') changeCount.current = status.changeCount;
    setFeed(withClockOffset(status));
    return changed;
  }, []);

  const isCurrentMonth = month === currentMonthKey();

  /** Datos nuevos para el cuadro abierto, sin cerrarlo. */
  const refreshOpen = useCallback((fresh: BankTransfer[]) => {
    const pickFresh = (current: BankTransfer | null) => (current ? fresh.find((t) => t.id === current.id) ?? current : current);
    setTaking(pickFresh);
    setDetail(pickFresh);
  }, []);

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    try {
      const view = filterRef.current === 'MIAS' ? 'TODAS' : filterRef.current;
      const { list, status } = await readBankFeedSnapshot(
        fetchBankFeedStatus,
        () => fetchBankTransfersPage({ month: monthRef.current, view, page: pageRef.current, pageSize: PAGE_SIZE, search: searchRef.current || undefined }),
      );
      if (request !== loadRequest.current) return;
      const { items: rows, ...info } = list;
      setItems(rows);
      refreshOpen(rows);
      setPageInfo(info);
      // Si la página quedó vacía (por ejemplo, se tomó la última de esa página), vuelve a la anterior.
      if (rows.length === 0 && info.total > 0 && info.page > 1) setPage(pageWindow(info.page, info.pageSize, info.total).page);
      applyFeed(status);
    } catch (e) {
      if (request === loadRequest.current) showToast('error', apiErrorMessage(e, 'No se pudieron cargar las transferencias.'));
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }, [applyFeed, refreshOpen, showToast]);

  /** Relee la página un instante después: junta varios avisos seguidos en una sola lectura. */
  const scheduleLoad = useCallback(() => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => void load(), 400);
  }, [load]);

  useEffect(() => () => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
  }, []);

  const loadMyClaims = useCallback(async () => {
    const request = ++myClaimsRequest.current;
    const requestedMonth = monthRef.current;
    setMyClaimsLoading(true);
    setMyClaimsError(null);
    try {
      const list = await fetchMyClaimsByMonth(requestedMonth);
      if (request === myClaimsRequest.current) {
        setMyClaimItems(list);
        setMyClaimsLoadedMonth(requestedMonth);
      }
    } catch (e) {
      if (request === myClaimsRequest.current) {
        setMyClaimItems([]);
        setMyClaimsError(apiErrorMessage(e, 'No se pudieron cargar tus tomas.'));
        setMyClaimsLoadedMonth(requestedMonth);
      }
    } finally {
      if (request === myClaimsRequest.current) setMyClaimsLoading(false);
    }
  }, []);

  // La búsqueda va al servidor (busca en todo el mes, no solo en la página), medio segundo después de tipear.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchQuery(search.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [month, filter, page, searchQuery, load]);

  useEffect(() => {
    if (filter === 'MIAS') void loadMyClaims();
  }, [filter, month, loadMyClaims]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const markFresh = (id: string) => {
    setFresh((prev) => ({ ...prev, [id]: Date.now() }));
    setTimeout(() => setFresh((prev) => {
      const { [id]: _, ...rest } = prev;
      return rest;
    }), FRESH_MS);
  };

  useEffect(() => {
    const socket = createRealtimeSocket();

    socket.on('connect', () => {
      setConnected(true);
      // La primera conexion no recarga: la lista ya se pidio al montar. Una reconexion si, porque
      // durante el corte pudieron entrar transferencias.
      if (!hasConnected.current) {
        hasConnected.current = true;
        return;
      }
      void load();
      if (filterRef.current === 'MIAS') void loadMyClaims();
    });
    socket.on('disconnect', () => setConnected(false));
    // Lo nuevo se ve resaltado; la página y los contadores se releen del servidor.
    socket.on('bank-transfers:new', (t: BankTransfer) => {
      markFresh(t.id);
      scheduleLoad();
    });
    socket.on('bank-transfers:updated', (t: BankTransfer) => {
      setItems((prev) => (prev.some((x) => x.id === t.id) ? upsertBankTransfer(prev, t) : prev));
      refreshOpen([t]);
      if (monthKeyOf(toDate(t.movementAt)) === monthRef.current || t.availableAmount > 0) scheduleLoad();
      if (filterRef.current === 'MIAS' && ownClaimsAffectedByTransfer(t, myClaimItemsRef.current, user.id)) void loadMyClaims();
      if (isAdmin && t.status === BankTransferStatus.REVERSADA && t.claims.length > 0) {
        showToast('error', `El banco reversó una transferencia ya tomada (${formatMoney(t.amount, t.currency)}, ${t.claims.map((c) => c.receiptNumber).join(', ')}).`);
      }
    });
    // Si el servidor registró transferencias y el aviso de alguna no llegó, se relee la lista.
    socket.on('bank-feed:status', (status: BankFeedStatus) => {
      if (applyFeed(status)) void load();
    });

    const fallback = setInterval(() => {
      if (socket.connected || document.visibilityState !== 'visible') return;
      void load();
      if (filterRef.current === 'MIAS') void loadMyClaims();
    }, FALLBACK_POLL_MS);

    // El banco solo se consulta mientras este panel este abierto y visible.
    const stopDemand = trackBankPanelDemand(socket, () => {
      void load();
      if (filterRef.current === 'MIAS') void loadMyClaims();
    });

    return () => {
      clearInterval(fallback);
      stopDemand();
      socket.disconnect();
    };
  }, [applyFeed, isAdmin, load, loadMyClaims, refreshOpen, scheduleLoad, showToast, user.id]);

  // Contadores del mes entero (los da el servidor); la lista ya viene filtrada y buscada.
  const counts = { DISPONIBLES: 0, TOMADAS: 0, REVISAR: 0, TODAS: 0, MIAS: 0, ...(pageInfo?.counts ?? {}) };
  // Tras tomar una, la página puede tener una que ya no corresponde a la pestaña hasta la relectura.
  const visible = useMemo(
    () => items.filter((t) => (filter === 'DISPONIBLES' ? isOpen(t) : true)),
    [filter, items],
  );
  const pages = pageInfo ? pageWindow(pageInfo.page, pageInfo.pageSize, pageInfo.total) : null;
  const otherMonthsPending = (pageInfo?.pendingOtherMonths ?? []).filter((m) => m.month !== month);
  const ownRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return ownClaimRows(myClaimItems, user.id).filter(({ transfer, claim }) =>
      !query || transferMatches(transfer, query) ||
      [claim.receiptNumber, claim.referenceValue, claim.voidReason]
        .some((value) => value?.toLowerCase().includes(query)));
  }, [myClaimItems, search, user.id]);

  const freshness = feedFreshness(feed, now);
  const tryTake = (t: BankTransfer) => {
    if (!canDirectlyClaim || !isOpen(t) || !isSupportedBankCurrency(t.currency)) return setDetail(t);
    setDetail(null);
    setTaking(t);
  };

  const toggle = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const reprint = async (t: BankTransfer, claimId: string) => {
    try {
      // El contador de impresiones se actualiza cuando la persona confirma que salió.
      onPrint(await openBankReceipt(t.id, claimId));
    } catch (e) {
      showToast('error', apiErrorMessage(e, 'No se pudo reimprimir el comprobante.'));
    }
  };

  const tabs: Array<{ key: Filter; label: string; show: boolean }> = [
    { key: 'DISPONIBLES', label: 'Disponibles', show: true },
    { key: 'MIAS', label: isCollector ? 'Mis conciliadas' : 'Mis tomas', show: canDirectlyClaim || isCollector },
    { key: 'TOMADAS', label: 'Tomadas', show: true },
    { key: 'REVISAR', label: 'Reversadas / en revisión', show: isAdmin },
    { key: 'TODAS', label: 'Todas', show: true },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Transferencias recibidas</h2>
          <p className="text-sm text-slate-500">
            {canDirectlyClaim
              ? 'Doble clic (o “Tomar”) en una transferencia disponible para tomarla. La flecha ▾ muestra los detalles.'
              : isCollector
                ? 'Lo que va entrando por la API del banco. Abrí una transferencia para conciliarla con tu consulta.'
                : isSupervisor
                  ? 'Lo que ingresa por la API del banco y quién tomó cada una. Vista de solo lectura.'
                  : 'Todo lo que ingresa por la API del banco, con quién tomó cada una. La flecha ▾ muestra los detalles.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FeedPill label={connected ? freshness.label : 'Reconectando…'} tone={connected ? freshness.tone : 'amber'} mock={feed?.mode === 'mock'} />
          {isAdmin && <AdminBalance />}
          <span className="text-xs text-slate-500">
            {(user.name || user.username).toUpperCase()} · {roleLabel(user.role)}
          </span>
        </div>
      </div>

      {isCurrentMonth && (freshness.stale || !connected) && feed?.state !== 'FUERA_DE_HORARIO' && (
        <div className="flex items-start gap-2 p-3 rounded-xl border border-amber-200 bg-amber-50 text-sm text-amber-900">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <div className="flex-1">
            <b>Los datos pueden no estar al día.</b> {feed?.lastError ? `Detalle: ${feed.lastError}` : 'Si esperás una transferencia que no aparece, consultá al administrador antes de entregar.'}
          </div>
          {isAdmin && feed?.state === 'DETENIDO' && (
            <button
              type="button"
              onClick={() => resumeBankFeed().then(applyFeed).catch((e) => showToast('error', apiErrorMessage(e, 'No se pudo reanudar.')))}
              className="px-3 py-1 rounded-lg bg-amber-600 text-white text-xs font-bold"
            >
              Reanudar
            </button>
          )}
        </div>
      )}

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex gap-1 overflow-x-auto bg-slate-100 p-1 rounded-xl">
          {tabs
            .filter((t) => t.show)
            .map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => {
                  if (t.key === 'MIAS') setMyClaimsLoadedMonth(null);
                  setFilter(t.key);
                  setPage(1);
                }}
                className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${filter === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                {t.label}{t.key === 'MIAS' ? '' : ` (${counts[t.key]})`}
              </button>
            ))}
        </div>
        <div className="flex items-center gap-2">
          {/* Mes para todos los roles, también la caja: antes solo veía el día de hoy. */}
          <label className="flex items-center gap-2 text-xs text-slate-600">
            Mes
            <input
              type="month"
              value={month}
              max={currentMonthKey()}
              onChange={(e) => {
                if (!/^\d{4}-\d{2}$/.test(e.target.value)) return;
                setMonth(e.target.value);
                setPage(1);
                setMyClaimsLoadedMonth(null);
              }}
              className="p-2 border rounded-lg text-sm"
            />
          </label>
          <div className="relative flex-1 lg:w-64">
            <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Monto, remitente, ticket…"
              className="w-full pl-8 pr-2 py-2 border rounded-lg text-sm"
            />
          </div>
          <BankRefreshButton
            status={feed}
            onStatus={applyFeed}
            showToast={showToast}
            onReload={() => (filter === 'MIAS' ? loadMyClaims() : load())}
          />
        </div>
      </div>

      {otherMonthsPending.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 p-3 rounded-xl border border-sky-200 bg-sky-50 text-sm text-sky-900" role="status">
          <span className="font-semibold">Sin tomar en otros meses:</span>
          {otherMonthsPending.map((m) => (
            <button
              key={m.month}
              type="button"
              onClick={() => {
                setMonth(m.month);
                setFilter('DISPONIBLES');
                setPage(1);
              }}
              className="px-2.5 py-1 rounded-lg bg-white border border-sky-300 text-xs font-bold hover:bg-sky-100"
            >
              {monthLabel(m.month)} ({m.count}) · ver
            </button>
          ))}
        </div>
      )}

      {filter === 'MIAS' ? (
        <MyClaimsList
          rows={ownRows}
          userId={user.id}
          role={user.role}
          loading={myClaimsLoading || myClaimsLoadedMonth !== month}
          error={myClaimsError}
          onRetry={() => void loadMyClaims()}
          onReprint={(transfer, claimId) => void reprint(transfer, claimId)}
        />
      ) : loading ? (
        <div className="flex items-center justify-center p-10 text-slate-500">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : visible.length === 0 ? (
        <div className="p-10 text-center text-sm text-slate-500 bg-white border rounded-xl">
          {searchQuery
            ? 'Ninguna transferencia del mes coincide con la búsqueda.'
            : filter === 'DISPONIBLES'
              ? `No quedan transferencias sin tomar en ${monthLabel(month)}.`
              : isCurrentMonth
                ? 'Todavía no hay transferencias este mes en esta pestaña.'
                : `No hubo transferencias en ${monthLabel(month)} en esta pestaña.`}
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map((t) => {
            const style = statusStyle(t.status);
            const isFresh = !!fresh[t.id];
            const available = isOpen(t);
            const claimable = available && isSupportedBankCurrency(t.currency);
            const open = !!expanded[t.id];
            const first = t.claims[0];
            const takenBy = !first
              ? null
              : t.claims.length > 1
                ? `repartida en ${t.claims.length}`
                : `${roleLabel(first.claimedByRole)} ${(first.claimedByName || first.claimedByUsername || '').toUpperCase()}`;
            return (
              <li
                key={t.id}
                className={`rounded-xl border border-l-4 transition ${style.row} ${isFresh ? 'ring-2 ring-emerald-400 shadow-md' : ''}`}
              >
                {/* Vista reducida: monto e ID de la transferencia. El resto se despliega con la flecha. */}
                <div
                  className="flex items-center gap-3 p-3 select-none cursor-pointer"
                  onClick={() => toggle(t.id)}
                  onDoubleClick={() => canDirectlyClaim && claimable && tryTake(t)}
                  role="button"
                  aria-expanded={open}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className={`text-lg font-black ${available ? 'text-slate-900' : 'text-slate-500'}`}>{formatMoney(t.amount, t.currency)}</span>
                      <span className="text-xs font-mono text-slate-500">ID {t.bankDocNumber || t.id.slice(0, 8)}</span>
                      <span className="text-xs text-slate-400">{formatDayTime(toDate(t.movementAt))}</span>
                      {t.status === BankTransferStatus.PARCIAL && (
                        <span className="text-xs font-bold text-sky-700">quedan {formatMoney(t.availableAmount, t.currency)}</span>
                      )}
                      {isFresh && <span className="text-[10px] font-bold text-emerald-600 uppercase">Nueva</span>}
                      {!isSupportedBankCurrency(t.currency) && (
                        <span className="text-[10px] font-bold text-amber-700 uppercase">Moneda no admitida para caja</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {t.source === 'MOCK' && <span className="hidden sm:inline px-1.5 rounded bg-fuchsia-100 text-fuchsia-700 text-[10px] font-bold">SIMULADA</span>}
                    <BankStatusBadge status={t.status} />
                    {takenBy && <span className="hidden sm:inline text-[11px] font-semibold text-slate-600">{takenBy}</span>}
                    {canDirectlyClaim && claimable && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          tryTake(t);
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700"
                      >
                        <Hand className="w-3.5 h-3.5" /> Tomar
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(t.id);
                      }}
                      className="p-1 rounded-lg text-slate-500 hover:bg-slate-200"
                      aria-label={open ? 'Ocultar detalles' : 'Ver detalles'}
                    >
                      <ChevronDown className={`w-5 h-5 transition-transform ${open ? 'rotate-180' : ''}`} />
                    </button>
                  </div>
                </div>

                {open && (
                  <div className="px-3 pb-3 pt-1 border-t border-slate-200/70 space-y-3">
                    {t.claims.length === 1 && (
                      <div className="text-sm font-bold text-slate-800 bg-white/70 border rounded-lg px-3 py-2">
                        {claimSummary(t.claims[0])} · {t.claims[0].receiptNumber}
                      </div>
                    )}
                    {t.claims.length > 1 && (
                      <div className="text-sm font-bold text-slate-800 bg-white/70 border rounded-lg px-3 py-2 space-y-1">
                        <div>{claimsSummary(t)}</div>
                        {t.availableAmount > 0 && (
                          <div className="text-sky-700">Quedan {formatMoney(t.availableAmount, t.currency)} sin cobrar.</div>
                        )}
                      </div>
                    )}
                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
                      {[
                        ['Banco de origen', t.senderBankName || 'No informado por el banco'],
                        ['Remitente', t.senderName || 'No informado'],
                        ['Documento', t.senderDoc || '--'],
                        ['Cuenta', t.senderAccount || '--'],
                        ['Concepto del remitente', t.senderNote || '--'],
                        ['Canal', t.channel ? `${t.channel} · ${t.concept}` : t.concept],
                        ['Motivo', t.sipapReason || '--'],
                        ['Ingresó', formatDateTime(t.movementAt)],
                        ['Ref. SIPAP', t.sipapReference || '--'],
                        ['ID (N° doc. banco)', t.bankDocNumber || '--'],
                      ].map(([label, value]) => (
                        <div key={label} className="flex justify-between gap-3 border-b border-slate-100 py-1">
                          <dt className="text-slate-500">{label}</dt>
                          <dd className="text-slate-800 font-medium text-right break-all">{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <div className="flex flex-wrap gap-2">
                      {canDirectlyClaim && claimable && (
                        <button type="button" onClick={() => tryTake(t)} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700">
                          <Hand className="w-3.5 h-3.5" /> Tomar este pago
                        </button>
                      )}
                      {t.claims.filter((claim) => canPrintClaim(claim, user.id, user.role)).map((claim) => (
                        <button key={claim.id} type="button" onClick={() => void reprint(t, claim.id)} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border bg-white text-xs font-semibold text-slate-700">
                          <Printer className="w-3.5 h-3.5" /> {claim.printCount > 0 ? 'Reimprimir' : 'Imprimir'} {claim.receiptNumber}
                        </button>
                      ))}
                      {isCollector && claimable && (
                        <button type="button" onClick={() => setDetail(t)} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-700">
                          <SlidersHorizontal className="w-3.5 h-3.5" /> Conciliar con mi consulta
                        </button>
                      )}
                      {isAdmin && (
                        <button type="button" onClick={() => setDetail(t)} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800 text-white text-xs font-semibold">
                          <SlidersHorizontal className="w-3.5 h-3.5" /> Acciones: conciliar, anular, historial
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {filter !== 'MIAS' && pages && pageInfo && pageInfo.total > pageInfo.pageSize && (
        <div className="flex items-center justify-between gap-3 text-xs text-slate-600">
          <span>
            Mostrando {pages.from}–{pages.to} de {pageInfo.total} · {monthLabel(month)}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={pages.page <= 1 || loading}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border bg-white font-semibold disabled:opacity-40"
            >
              <ChevronLeft className="w-4 h-4" /> Anterior
            </button>
            <span>Página {pages.page} de {pages.pages}</span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pages.pages, p + 1))}
              disabled={pages.page >= pages.pages || loading}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border bg-white font-semibold disabled:opacity-40"
            >
              Siguiente <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {taking && (
        <TakeTransferModal
          transfer={taking}
          user={user}
          onClose={() => setTaking(null)}
          onTaken={(t, receipt, receiptNumber) => {
            setItems((prev) => upsertBankTransfer(prev, t));
            setTaking(null);
            if (receipt) {
              showToast('success', `Pago tomado. Comprobante ${receipt.receiptNumber}.`);
              onPrint(receipt);
            } else {
              setFilter('MIAS');
              setExpanded((prev) => ({ ...prev, [t.id]: true }));
              showToast('error', `Toma ${receiptNumber} registrada, pero no se pudo abrir el comprobante. Imprimilo desde Mis tomas.`);
            }
          }}
        />
      )}

      {detail && !taking && (
        <TransferDetailModal
          transfer={detail}
          user={user}
          onClose={() => setDetail(null)}
          onChanged={(t) => {
            setItems((prev) => upsertBankTransfer(prev, t));
            refreshOpen([t]);
          }}
          onPrint={onPrint}
          showToast={showToast}
        />
      )}
    </div>
  );
};
