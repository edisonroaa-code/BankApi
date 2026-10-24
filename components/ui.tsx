import { AlertCircle, CheckCircle, X, XCircle } from 'lucide-react';
import { Payment, PaymentState, User } from '../types';
import { parseDbTimestamp } from '../services/date';
import { destinationLabel, ticketVerificationLabel } from '../services/payment-destination';
import { loadCompanyProfile } from '../services/company-profile';

export interface Toast {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

export const ToastContainer = ({ toasts, removeToast }: { toasts: Toast[]; removeToast: (id: string) => void }) => {
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`
            min-w-[300px] p-4 rounded-lg shadow-lg border-l-4 flex items-center justify-between animate-in slide-in-from-right duration-300
            ${toast.type === 'success' ? 'bg-white border-green-500 text-slate-800' : ''}
            ${toast.type === 'error' ? 'bg-white border-red-500 text-slate-800' : ''}
            ${toast.type === 'info' ? 'bg-white border-blue-500 text-slate-800' : ''}
          `}
        >
          <div className="flex items-center gap-3">
            {toast.type === 'success' && <CheckCircle className="w-5 h-5 text-green-500" />}
            {toast.type === 'error' && <XCircle className="w-5 h-5 text-red-500" />}
            {toast.type === 'info' && <AlertCircle className="w-5 h-5 text-blue-500" />}
            <span className="text-sm font-medium">{toast.message}</span>
          </div>
          <button onClick={() => removeToast(toast.id)} className="text-gray-400 hover:text-gray-600">
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
};

export const StatusBadge = ({ status }: { status: PaymentState }) => {
  const colors = {
    [PaymentState.PENDIENTE_VERIFICACION]: 'bg-yellow-100 text-yellow-800 border-yellow-200',
    [PaymentState.EN_REVISION]: 'En revisión',
    [PaymentState.CONFIRMADO]: 'Ingreso',
    [PaymentState.CONFIRMADO_MANUAL]: 'Ingreso',
    [PaymentState.RECHAZADO]: 'bg-red-100 text-red-800 border-red-200',
  };

  const labels = {
    [PaymentState.PENDIENTE_VERIFICACION]: 'Pendiente',
    [PaymentState.EN_REVISION]: 'En revisión',
    [PaymentState.CONFIRMADO]: 'Ingreso',
    [PaymentState.CONFIRMADO_MANUAL]: 'Ingreso',
    [PaymentState.RECHAZADO]: 'Rechazado',
  };

  return <span className={`px-2 py-1 rounded-full text-xs font-medium border ${colors[status]}`}>{labels[status]}</span>;
};

export const GlobalStyles = () => (
  <style>{`
    /* Custom Scrollbar for Webkit */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #94a3b8; }

    @media print {
      @page {
        margin: 0;
        size: auto;
      }
      
      /* Hide everything by default */
      body * {
        visibility: hidden;
      }
      
      body {
        margin: 0;
        padding: 0;
        background: white;
      }
      
      /* Show only the printable area */
      #printable-ticket-container, #printable-ticket-container * {
        visibility: visible;
      }
      
      /* Position the ticket at the top left */
      #printable-ticket-container {
        position: absolute;
        left: 0;
        top: 0;
        width: 80mm;
        font-family: 'Courier New', Courier, monospace; 
        color: #000000 !important;
        background: white;
        display: block !important;
        padding-top: 10px;
        font-weight: 700 !important;
        font-size: 14px;
        line-height: 1.2;
      }
      
      /* Ensure borders are black */
      .print-border-black {
        border-color: #000000 !important;
        border-width: 2px !important;
      }
      
      /* Hide non-print elements */
      nav, button, .modal-backdrop, .no-print { display: none !important; }
    }
  `}</style>
);

export const PrintableTicket = ({ payment, user }: { payment: Payment | null; user: User | null }) => {
  if (!payment) return null;
  const createdAt = parseDbTimestamp(payment.createdAt) ?? new Date(payment.createdAt);
  const verifiedAt = payment.verifiedAt ? (parseDbTimestamp(payment.verifiedAt) ?? new Date(payment.verifiedAt)) : null;
  const printedAt = payment.printedAt ? (parseDbTimestamp(payment.printedAt) ?? new Date(payment.printedAt)) : null;
  const ticketTime = printedAt || verifiedAt || createdAt;

  const formatPyDate = (dt: Date) =>
    new Intl.DateTimeFormat('es-PY', {
      timeZone: 'America/Asuncion',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(dt);

  const formatPyTime = (dt: Date) =>
    new Intl.DateTimeFormat('es-PY', {
      timeZone: 'America/Asuncion',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(dt);

  const verifiedBy = (payment.verifiedByName ||
    payment.verifiedByUsername ||
    'NO REGISTRADO').toString().toUpperCase();
  const company = loadCompanyProfile();
  return (
    <div id="printable-ticket-container" className="hidden print:block p-2 bg-white text-black">
      {payment.reprint && (
        <div className="text-center mb-2 border-2 border-black py-1 font-bold uppercase text-sm print-border-black">
          TICKET RE-IMPRIMIDO
        </div>
      )}
      <div className="text-center mb-4 border-b-2 border-black pb-2 print-border-black">
        <h1 className="text-xl font-black uppercase tracking-tight">{company.companyName}</h1>
        {company.companyRuc && <p className="text-[11px] font-bold uppercase">RUC: {company.companyRuc}</p>}
        <p className="text-xs font-bold uppercase mt-1">Comprobante verificado</p>
      </div>
      <div className="text-sm space-y-1 mb-4 font-bold">
        <div className="flex justify-between">
          <span>FECHA:</span>
          <span>{formatPyDate(ticketTime)}</span>
        </div>
        <div className="flex justify-between">
          <span>HORA:</span>
          <span>{formatPyTime(ticketTime)}</span>
        </div>
        <div className="border-b border-black my-2 print-border-black"></div>
        <p>
          <strong>REF:</strong> {payment.paymentRef}
        </p>
        <p>
          <strong>BANCO ORIGEN:</strong><br />
          {(payment.sourceBank || 'NO REGISTRADO').toUpperCase()}
        </p>
        <p>
          <strong>DESTINO DECLARADO:</strong><br />
          {destinationLabel(payment.isAtlasAccount).toUpperCase()}
        </p>
        <p>
          <strong>MÉTODO:</strong><br />
          {ticketVerificationLabel(payment)}
        </p>
        <p>
          <strong>CLIENTE:</strong> {payment.clientName?.slice(0, 20) || 'N/A'}
        </p>
        <p>
          <strong>COD:</strong> {payment.clientCode}
        </p>
      </div>
      <div className="text-right text-2xl font-black border-t-2 border-b-2 border-black py-2 mb-4 print-border-black">
        {new Intl.NumberFormat('es-PY', { style: 'currency', currency: 'PYG' }).format(payment.amount)}
      </div>
      <div className="text-[10px] text-center font-bold">
        <p>
          VERIFICADO POR: {verifiedBy}
        </p>
        <p className="mt-2 uppercase">*** DOCUMENTO INTERNO ***</p>
        <p>{company.ticketFooter}</p>
      </div>
    </div>
  );
};

