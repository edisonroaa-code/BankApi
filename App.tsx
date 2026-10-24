import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LogOut, Menu, X, AlertCircle, Loader2 } from 'lucide-react';
import { BankReceipt, Payment, User, UserRole } from './types';
import { GlobalStyles, PrintableTicket, Toast, ToastContainer } from './components/ui';
import { BankTransferReceipt } from './components/BankTransferReceipt';
import { PrintConfirmDialog } from './components/PrintConfirmDialog';
import { apiErrorMessage, confirmBankReceiptPrint, openBankReceipt } from './services/bankTransfers';
import { confirmPaymentTicketPrint, fetchPaymentDetail, openPaymentTicket } from './services/payments';
import { notifyPaymentPrinted } from './services/print-events';
import { LoginView } from './views/LoginView';
import { StartCenterView } from './views/StartCenterView';
import { api, initializeApiBaseURL } from './services/api';
import { loadCompanyProfile } from './services/company-profile';

// Cargar los módulos antes de abrir formularios: cuando otra pestaña activa la PWA,
// Workbox elimina los chunks anteriores. La pestaña que pospuso debe seguir operando
// con su código en memoria, conservando borradores/adjuntos hasta aceptar la recarga.
import { CobradorDashboard } from './views/CobradorDashboard';
import { AdminDashboard } from './views/AdminDashboard';
import { WorkPanelView } from './views/WorkPanelView';
import { BankTransfersPanel } from './views/BankTransfersPanel';
import { ReconciliationView } from './views/ReconciliationView';

type Page = 'DASHBOARD' | 'PANEL' | 'TRANSFERS' | 'RECONCILE';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [page, setPage] = useState<Page>('DASHBOARD');
  const [authView, setAuthView] = useState<'LOGIN' | 'START'>('LOGIN');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [printingPayment, setPrintingPayment] = useState<Payment | null>(null);
  const [printingReceipt, setPrintingReceipt] = useState<BankReceipt | null>(null);
  // El navegador no sabe si en el diálogo se imprimió o se canceló: al cerrarlo se pregunta, y solo
  // un "Sí" cuenta el ticket como impreso.
  const [askPrinted, setAskPrinted] = useState(false);
  const [printRun, setPrintRun] = useState(0);
  const [confirmingPrint, setConfirmingPrint] = useState(false);
  const [health, setHealth] = useState<'unknown' | 'ok' | 'down'>('unknown');
  const [apiReady, setApiReady] = useState(false);
  const [companyName, setCompanyName] = useState(() => loadCompanyProfile().companyName || 'BankApi');
  const toastSeq = useRef(0);

  useEffect(() => {
    const syncProfile = () => setCompanyName(loadCompanyProfile().companyName || 'BankApi');
    window.addEventListener('bankapi:company-profile-updated', syncProfile);
    return () => window.removeEventListener('bankapi:company-profile-updated', syncProfile);
  }, []);

  const showPaymentTicket = useCallback((payment: Payment) => {
    setPrintingReceipt(null);
    setPrintingPayment(payment);
    setAskPrinted(false);
    setPrintRun((n) => n + 1);
  }, []);

  const showBankReceipt = useCallback((receipt: BankReceipt) => {
    setPrintingPayment(null);
    setPrintingReceipt(receipt);
    setAskPrinted(false);
    setPrintRun((n) => n + 1);
  }, []);

  const clearPrinting = useCallback(() => {
    setPrintingPayment(null);
    setPrintingReceipt(null);
    setAskPrinted(false);
  }, []);

  useEffect(() => {
    if ((!printingPayment && !printingReceipt) || askPrinted) return;
    const dialogClosed = () => setAskPrinted(true);
    window.addEventListener('afterprint', dialogClosed);
    // Algunos navegadores no disparan afterprint, pero sí avisan al salir de @media print.
    const printMedia = typeof window.matchMedia === 'function' ? window.matchMedia('print') : null;
    const onPrintMediaChange = (event: MediaQueryListEvent) => {
      if (!event.matches) dialogClosed();
    };
    if (printMedia?.addEventListener) printMedia.addEventListener('change', onPrintMediaChange);
    else printMedia?.addListener?.(onPrintMediaChange);
    const timer = window.setTimeout(() => {
      window.print();
    }, 100);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('afterprint', dialogClosed);
      if (printMedia?.removeEventListener) printMedia.removeEventListener('change', onPrintMediaChange);
      else printMedia?.removeListener?.(onPrintMediaChange);
    };
  }, [printingPayment, printingReceipt, askPrinted, printRun]);

  // La caja tiene un panel propio y exclusivo: no ve el panel de trabajo ni el de consultas.
  const isCashier = user?.role === UserRole.CAJERO;
  const isSupervisor = user?.role === UserRole.SUPERVISOR;
  // El cobrador no tiene "Transferencias": Conciliacion ya le muestra lo que entro al lado de sus
  // consultas y ahi tiene "Mis conciliadas" (decision del 2026-10-07, para no duplicar pantallas).
  const canSeeBankTransfers = isCashier || isSupervisor || user?.role === UserRole.ADMIN;
  // La caja no concilia consultas: cobra contra un ticket. El supervisor entra al modulo en solo
  // lectura (decision del 2026-10-07); el backend tampoco le permite conciliar.
  const canReconcile = isSupervisor || user?.role === UserRole.ADMIN || user?.role === UserRole.COBRADOR;
  const currentPage: Page = isCashier ? 'TRANSFERS' : page;

  useEffect(() => {
    const session = localStorage.getItem('bankapi_session_v1');
    if (!session) return;
    try {
      const data = JSON.parse(session);
      if (data?.access_token && data?.user) {
        setUser(data.user);
      } else {
        localStorage.removeItem('bankapi_session_v1');
      }
    } catch {
      localStorage.removeItem('bankapi_session_v1');
    }
  }, []);

  useEffect(() => {
    let active = true;
    initializeApiBaseURL().finally(() => {
      if (active) setApiReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!apiReady) return;
    let active = true;

    const check = async () => {
      try {
        if (!active) return;
        await api.get('/health', { timeout: 5000 });
        setHealth('ok');
      } catch {
        if (!active) return;
        setHealth('down');
      }
    };
    check();
    // Solo consultar con la pestana visible: una pestana olvidada abierta
    // mantenia el backend (y antes la base) despierto las 24 horas.
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      check();
    }, 30000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [apiReady]);

  /** "Sí, salió impreso": recién ahora cuenta. Una conciliación también completa el ticket de su consulta. */
  const confirmPrinted = async () => {
    if (confirmingPrint) return;
    setConfirmingPrint(true);
    try {
      if (printingReceipt) {
        if (!printingReceipt.transferId || !printingReceipt.claimId) throw new Error('Comprobante sin identificar.');
        await confirmBankReceiptPrint(printingReceipt.transferId, printingReceipt.claimId);
        // El comprobante de una conciliación es el ticket de su consulta: las pantallas la ven impresa ya.
        const paymentId = printingReceipt.paymentId;
        if (paymentId) void fetchPaymentDetail(paymentId).then(notifyPaymentPrinted).catch(() => undefined);
      } else if (printingPayment) {
        // Las pantallas que muestran esta consulta pasan a "Re-imprimir" y habilitan "Marcar pago en caja".
        notifyPaymentPrinted(await confirmPaymentTicketPrint(printingPayment.id));
      }
      showToast('success', 'Impresión registrada.');
      clearPrinting();
    } catch (e) {
      showToast('error', apiErrorMessage(e, 'No se pudo registrar la impresión. Probá de nuevo.'));
    } finally {
      setConfirmingPrint(false);
    }
  };

  const notPrinted = () => {
    clearPrinting();
    showToast('info', 'No se registró la impresión. Podés imprimirlo de nuevo cuando quieras.');
  };

  const printAgain = async () => {
    if (confirmingPrint) return;
    setConfirmingPrint(true);
    try {
      // Cada nueva apertura se audita y revalida el estado/permisos, incluso tras cancelar.
      if (printingReceipt) {
        showBankReceipt(await openBankReceipt(printingReceipt.transferId, printingReceipt.claimId));
      } else if (printingPayment) {
        const preview = await openPaymentTicket(printingPayment.id);
        showPaymentTicket({ ...preview, reprint: !!preview.printedAt });
      }
    } catch (e) {
      showToast('error', apiErrorMessage(e, 'No se pudo volver a abrir el comprobante.'));
    } finally {
      setConfirmingPrint(false);
    }
  };

  const showToast = useCallback((type: 'success' | 'error' | 'info', message: string) => {
    const id =
      typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function'
        ? (crypto as any).randomUUID()
        : `${Date.now()}-${++toastSeq.current}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const removeToast = (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id));

  const handleLogout = useCallback(() => {
    localStorage.removeItem('bankapi_session_v1');
    setPrintingPayment(null);
    setPrintingReceipt(null);
    setUser(null);
    setPage('DASHBOARD');
  }, []);

  useEffect(() => {
    const onExpired = () => {
      showToast('error', 'Sesión expirada. Volvé a iniciar sesión.');
      handleLogout();
    };
    const onLogout = () => handleLogout();

    window.addEventListener('auth:session-expired', onExpired as any);
    window.addEventListener('auth:logout', onLogout as any);
    return () => {
      window.removeEventListener('auth:session-expired', onExpired as any);
      window.removeEventListener('auth:logout', onLogout as any);
    };
  }, [handleLogout, showToast]);

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-slate-600">
      <GlobalStyles />
      <ToastContainer toasts={toasts} removeToast={removeToast} />

      {!apiReady ? (
        <div className="min-h-screen flex items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-slate-600" />
        </div>
      ) : !user ? (
        authView === 'START' ? (
          <StartCenterView onBack={() => setAuthView('LOGIN')} />
        ) : (
          <LoginView
            onLogin={() => {
              const s = localStorage.getItem('bankapi_session_v1');
              if (!s) return;
              const parsed = JSON.parse(s);
              if (parsed?.access_token && parsed?.user) setUser(parsed.user);
            }}
            onOpenStart={() => setAuthView('START')}
          />
        )
      ) : (
        <>
          {printingReceipt ? <BankTransferReceipt receipt={printingReceipt} /> : <PrintableTicket payment={printingPayment} user={user} />}
          {askPrinted && (printingReceipt || printingPayment) && (
            <PrintConfirmDialog
              label={printingReceipt
                ? `Comprobante ${printingReceipt.receiptNumber}`
                : `Ticket de la consulta ${printingPayment?.paymentRef || printingPayment?.clientCode || ''}`.trim()}
              busy={confirmingPrint}
              onPrinted={() => void confirmPrinted()}
              onPrintAgain={() => void printAgain()}
              onNotPrinted={notPrinted}
            />
          )}

          <nav className="bg-slate-900/95 backdrop-blur-sm border-b border-emerald-900/40 text-white shadow-lg sticky top-0 z-40 no-print">
            <div className="max-w-5xl mx-auto px-3 sm:px-4">
              <div className="flex justify-between items-center h-16">
                <div className="min-w-0 flex flex-1 items-center gap-2.5 font-bold text-base sm:text-lg">
                  <img
                    src={`${import.meta.env.BASE_URL}logo.png`}
                    alt="BankApi"
                    className="w-8 h-8 shrink-0 rounded-lg bg-slate-800 p-0.5 ring-1 ring-emerald-500/40"
                  />
                  <span className="truncate tracking-tight">BankApi</span>
                  {companyName && companyName.toLowerCase() !== 'bankapi' && (
                    <span className="hidden sm:inline-block text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 truncate max-w-[180px]">
                      {companyName}
                    </span>
                  )}
                </div>

                <div className="hidden md:flex items-center gap-6 text-sm">
                  <span className="text-slate-400 flex items-center gap-2">
                    <span
                      className={`inline-block w-2 h-2 rounded-full ${health === 'ok' ? 'bg-green-500' : health === 'down' ? 'bg-red-500' : 'bg-gray-500'
                        }`}
                    />
                    Hola, {user.name || user.username} ({user.role})
                  </span>
                  {isCashier ? (
                    <span className="text-white font-semibold">Transferencias</span>
                  ) : (
                    <>
                      <button type="button" onClick={() => setPage('DASHBOARD')} className={`hover:text-white transition ${page === 'DASHBOARD' ? 'text-white' : 'text-slate-200'}`}>
                        Panel de trabajo
                      </button>
                      <button type="button" onClick={() => setPage('PANEL')} className={`hover:text-white transition ${page === 'PANEL' ? 'text-white' : 'text-slate-200'}`}>
                        Mi panel
                      </button>
                      {canSeeBankTransfers && (
                        <button type="button" onClick={() => setPage('TRANSFERS')} className={`hover:text-white transition ${page === 'TRANSFERS' ? 'text-white' : 'text-slate-200'}`}>
                          Transferencias
                        </button>
                      )}
                      {canReconcile && (
                        <button type="button" onClick={() => setPage('RECONCILE')} className={`hover:text-white transition ${page === 'RECONCILE' ? 'text-white' : 'text-slate-200'}`}>
                          Conciliación
                        </button>
                      )}
                    </>
                  )}
                  <button
                    onClick={handleLogout}
                    className="flex items-center gap-2 text-white hover:text-red-400 transition"
                  >
                    <LogOut className="w-4 h-4" /> Salir
                  </button>
                </div>

                <button className="md:hidden shrink-0 p-2 -mr-2" onClick={() => setMenuOpen((v) => !v)} aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'}>
                  {menuOpen ? <X /> : <Menu />}
                </button>
              </div>
            </div>

            {menuOpen && (
              <div className="md:hidden bg-slate-800 p-4 space-y-4">
                <p className="text-slate-400 text-sm flex items-center gap-2">
                  <span
                    className={`inline-block w-2 h-2 rounded-full ${health === 'ok' ? 'bg-green-500' : health === 'down' ? 'bg-red-500' : 'bg-gray-500'
                      }`}
                  />
                  Usuario: {user.name || user.username}
                </p>
                {!isCashier && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setPage('DASHBOARD');
                        setMenuOpen(false);
                      }}
                      className="w-full text-left text-slate-200"
                    >
                      Panel de trabajo
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setPage('PANEL');
                        setMenuOpen(false);
                      }}
                      className="w-full text-left text-slate-200"
                    >
                      Mi panel
                    </button>
                  </>
                )}
                {canSeeBankTransfers && (
                  <button
                    type="button"
                    onClick={() => {
                      setPage('TRANSFERS');
                      setMenuOpen(false);
                    }}
                    className="w-full text-left text-slate-200"
                  >
                    Transferencias
                  </button>
                )}
                {canReconcile && (
                  <button
                    type="button"
                    onClick={() => {
                      setPage('RECONCILE');
                      setMenuOpen(false);
                    }}
                    className="w-full text-left text-slate-200"
                  >
                    Conciliación
                  </button>
                )}
                <button onClick={handleLogout} className="w-full text-left text-red-400 flex items-center gap-2">
                  <LogOut className="w-4 h-4" /> Cerrar sesión
                </button>
              </div>
            )}
          </nav>

          <main className="max-w-5xl mx-auto p-4 md:p-6 no-print relative">
            {health === 'down' && (
              <div className="absolute inset-0 z-50 bg-white/80 backdrop-blur-sm flex items-center justify-center rounded-lg">
                <div className="bg-red-50 p-6 rounded-xl border-2 border-red-200 shadow-xl max-w-sm text-center">
                  <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
                  <h3 className="text-xl font-bold text-red-700 mb-2">Sin conexión al servidor</h3>
                  <p className="text-red-600 text-sm">
                    El servidor principal parece estar apagado o reiniciándose. <br />
                    Tus formularios y adjuntos están seguros y no se borrarán.
                    <br /><br />
                    <b>Por favor, esperá sin recargar la página.</b>
                  </p>
                  <div className="mt-6 flex flex-col items-center justify-center gap-3">
                    <Loader2 className="w-6 h-6 animate-spin text-red-500" />

                    {typeof window !== 'undefined' && (window as any).bankapi?.services?.setMainServer && (
                      <button
                        onClick={async () => {
                          showToast('info', 'Habilitando esta máquina como servidor principal. Iniciando motores locales...');
                          await (window as any).bankapi.services.setMainServer();
                        }}
                        className="mt-2 text-xs font-bold text-red-700 underline cursor-pointer hover:text-red-900 border-none bg-transparent"
                      >
                        ¿Esta máquina es el Servidor? Forzar inicio
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className={`transition-opacity duration-300 ${health === 'down' ? 'opacity-20 pointer-events-none' : 'opacity-100'}`}>
              {currentPage === 'TRANSFERS' && canSeeBankTransfers ? (
                <BankTransfersPanel user={user} showToast={showToast} onPrint={showBankReceipt} />
              ) : currentPage === 'RECONCILE' && canReconcile ? (
                <ReconciliationView user={user} showToast={showToast} onPrint={showBankReceipt} />
              ) : currentPage === 'DASHBOARD' ? (
                <WorkPanelView showToast={showToast} user={user} />
              ) : user.role === UserRole.COBRADOR ? (
                <CobradorDashboard user={user} showToast={showToast} onPrint={showPaymentTicket} />
              ) : (
                <AdminDashboard showToast={showToast} user={user} onPrintPayment={showPaymentTicket} onPrintReceipt={showBankReceipt} />
              )}
            </div>
          </main>
        </>
      )}
    </div>
  );
}
