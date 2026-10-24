import React from 'react';
import { Loader2, Printer } from 'lucide-react';
import { BankClaim, BankTransfer } from '../../types';
import { canReprintOwnClaim } from '../../services/my-bank-claims';
import { BankStatusBadge, formatDateTime, formatMoney, referenceText } from './bankUi';

/**
 * Historial propio de tomas o conciliaciones, con reimpresión del comprobante. Lo usan
 * "Mis tomas" de Transferencias (caja y admin) y "Mis conciliadas" de Conciliación (cobrador).
 * Una toma anulada se muestra con su motivo y ya no se puede reimprimir.
 */
export const MyClaimsList = ({
  rows,
  userId,
  role,
  loading,
  error,
  onRetry,
  onReprint,
  noun = 'tomas',
}: {
  rows: Array<{ transfer: BankTransfer; claim: BankClaim }>;
  userId: string;
  role: string;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onReprint: (transfer: BankTransfer, claimId: string) => void;
  /** "tomas" o "conciliaciones", para los textos. */
  noun?: 'tomas' | 'conciliaciones';
}) => {
  const isReconciliation = noun === 'conciliaciones';
  if (loading) {
    return (
      <div className="flex items-center justify-center p-10 text-slate-500" role="status">
        <Loader2 className="w-6 h-6 animate-spin" /> Cargando tus {noun}…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
        <p>{error}</p>
        <button type="button" onClick={onRetry} className="mt-2 rounded-lg border border-red-300 bg-white px-3 py-1.5 font-semibold">Reintentar</button>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="p-10 text-center text-sm text-slate-500 bg-white border rounded-xl">
        {isReconciliation ? 'No tenés conciliaciones registradas en esta fecha.' : 'No tenés tomas ni conciliaciones registradas en esta fecha.'}
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {rows.map(({ transfer, claim }) => (
        <li key={claim.id} className={`rounded-xl border border-l-4 p-3 space-y-2 ${claim.status === 'ANULADA' ? 'border-red-300 border-l-red-600 bg-red-50' : 'border-slate-200 border-l-emerald-600 bg-white'}`}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-sm font-bold text-slate-900">{formatMoney(claim.amount, transfer.currency)} · {referenceText(claim)}</p>
              <p className="text-xs text-slate-600">
                Comprobante {claim.receiptNumber} · {isReconciliation ? 'conciliada' : 'tomado'} el {formatDateTime(claim.claimedAt)}
              </p>
              <p className="text-xs text-slate-500">Movimiento {transfer.bankDocNumber || transfer.id.slice(0, 8)} · {transfer.senderName || 'Remitente no informado'}</p>
            </div>
            <span className={`px-2 py-1 rounded-full text-[11px] font-bold ${claim.status === 'ANULADA' ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800'}`}>
              {claim.status === 'ANULADA' ? (isReconciliation ? 'CONCILIACIÓN ANULADA' : 'TOMA ANULADA') : isReconciliation ? 'CONCILIADA' : 'TOMA ACTIVA'}
            </span>
          </div>
          {claim.status === 'ANULADA' ? (
            <div className="text-xs text-red-900 border-t border-red-200 pt-2" role="status">
              <p>Anulada por {claim.voidedByName || 'administración'}{claim.voidedAt ? ` el ${formatDateTime(claim.voidedAt)}` : ''}</p>
              <p><strong>Motivo:</strong> {claim.voidReason || 'No informado'}</p>
              <p className="mt-1">Ya no vale ni se puede reimprimir. Anularla no revierte el movimiento en el banco.</p>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2 items-center border-t pt-2">
              <BankStatusBadge status={transfer.status} />
              {canReprintOwnClaim(claim, userId, role) && (
                <button type="button" onClick={() => onReprint(transfer, claim.id)} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border bg-white text-xs font-semibold text-slate-700">
                  <Printer className="w-3.5 h-3.5" /> {claim.printCount > 0 ? 'Reimprimir' : 'Imprimir'} {claim.receiptNumber}
                </button>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
};
