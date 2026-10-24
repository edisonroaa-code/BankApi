import React, { useEffect, useState } from 'react';
import { canPrintClaim } from '../../services/print-policy';
import { AlertCircle, History, Link2, Loader2, Printer, ShieldOff, Unlock, X } from 'lucide-react';
import { BankClaim, BankReceipt, BankTransfer, BankTransferStatus, CandidatePayment, User, UserRole } from '../../types';
import {
  apiErrorMessage,
  openReconciliationReceipt,
  fetchBankTransferHistory,
  fetchCandidatePayments,
  newOperationKey,
  openBankReceipt,
  reconcileBankTransfer,
  releaseBankTransfer,
  voidBankClaim,
} from '../../services/bankTransfers';
import { registerAndDisplayReceipt } from '../../services/receipt-registration';
import { isSupportedBankCurrency } from '../../services/bank-claim-policy';
import { BankStatusBadge, MatchBadge, claimSummary, formatDateTime, formatMoney, referenceText, roleLabel } from './bankUi';

type Mode = 'VIEW' | 'VOID' | 'RELEASE' | 'RECONCILE' | 'HISTORY';

const AUDIT_LABELS: Record<string, string> = {
  BANK_TRANSFER_CLAIMED: 'Tomada',
  BANK_TRANSFER_CLAIM_CONFLICT: 'Intento de tomarla (rechazado)',
  BANK_TRANSFER_CLAIM_VOIDED: 'Toma anulada',
  BANK_TRANSFER_RECEIPT_PRINTED: 'Solicitud de impresión del comprobante',
  BANK_TRANSFER_REVERSED: 'Reversada por el banco',
  BANK_TRANSFER_BLOCKED: 'Bloqueada por posible duplicado',
  BANK_TRANSFER_RELEASED: 'Liberada por el admin',
  PAYMENT_BANK_RECONCILED: 'Conciliada con una consulta',
  PAYMENT_BANK_RECONCILIATION_VOIDED: 'Conciliación anulada',
};

const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex justify-between gap-3 py-1.5 border-b border-slate-100 text-sm">
    <span className="text-slate-500">{label}</span>
    <span className="text-slate-800 font-medium text-right break-all">{value || '--'}</span>
  </div>
);

export const TransferDetailModal = ({
  transfer,
  user,
  onClose,
  onChanged,
  onPrint,
  showToast,
}: {
  transfer: BankTransfer;
  user: User;
  onClose: () => void;
  onChanged: (transfer: BankTransfer) => void;
  onPrint: (receipt: BankReceipt) => void;
  showToast: (t: 'success' | 'error' | 'info', m: string) => void;
}) => {
  const isAdmin = user.role === UserRole.ADMIN;
  const [mode, setMode] = useState<Mode>('VIEW');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CandidatePayment[] | null>(null);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof fetchBankTransferHistory>> | null>(null);
  // Con pagos partidos una transferencia puede tener varias tomas: hay que elegir sobre cual se opera.
  const claims = transfer.claims;
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [voidClaimId, setVoidClaimId] = useState<string | null>(null);
  const claim = claims.find((c) => c.id === selectedClaimId) ?? (claims.length === 1 ? claims[0] : null);
  const voidClaim = claims.find((c) => c.id === voidClaimId);
  const canReprint = !!claim && canPrintClaim(claim, user.id, user.role);
  const available = transfer.availableAmount;
  const canReconcile =
    (isAdmin || user.role === UserRole.COBRADOR) &&
    isSupportedBankCurrency(transfer.currency) &&
    available > 0 &&
    transfer.status !== BankTransferStatus.REVERSADA &&
    transfer.status !== BankTransferStatus.BLOQUEADA;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  useEffect(() => {
    setError(null);
    if (mode === 'RECONCILE') {
      setCandidates(null);
      fetchCandidatePayments(transfer.id).then(setCandidates).catch((e) => setError(apiErrorMessage(e, 'No se pudieron cargar las consultas.')));
    }
    if (mode === 'HISTORY') {
      setHistory(null);
      fetchBankTransferHistory(transfer.id).then(setHistory).catch((e) => setError(apiErrorMessage(e, 'No se pudo cargar el historial.')));
    }
  }, [mode, transfer.id]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(apiErrorMessage(e, 'No se pudo completar la operación.'));
    } finally {
      setBusy(false);
    }
  };

  const reprint = () =>
    run(async () => {
      await registerAndDisplayReceipt(() => openBankReceipt(transfer.id, claim?.id), onPrint);
    });

  const doVoid = () => {
    if (!voidClaimId || !voidClaim) {
      setError('La toma elegida ya no está activa. Volvé al detalle y actualizá la transferencia.');
      return;
    }
    return run(async () => {
      const updated = await voidBankClaim(transfer.id, reason.trim(), voidClaimId);
      onChanged(updated);
      setSelectedClaimId(null);
      setVoidClaimId(null);
      const movementUnavailable = updated.status === BankTransferStatus.REVERSADA || updated.status === BankTransferStatus.BLOQUEADA;
      showToast('success', movementUnavailable
        ? 'Toma anulada y auditada. El movimiento sigue reversado o bloqueado; no está disponible para una nueva toma.'
        : 'Toma anulada y auditada. Ese monto volvió a quedar disponible para una nueva toma.');
      setMode('VIEW');
      setReason('');
    });
  };

  const doRelease = () =>
    run(async () => {
      const updated = await releaseBankTransfer(transfer.id, reason.trim());
      onChanged(updated);
      showToast('success', 'Transferencia liberada.');
      setMode('VIEW');
      setReason('');
    });

  const doReconcile = (payment: CandidatePayment) => {
    const label = `${payment.paymentRef || payment.id.slice(0, 8)} de ${payment.collectorName || 'cobrador'}`;
    const applied = Math.min(available, payment.pendingAmount);
    const covers = applied >= payment.pendingAmount;
    const detail = covers
      ? `Se aplican ${formatMoney(applied, transfer.currency)} y la consulta queda aprobada.`
      : `Se aplican ${formatMoney(applied, transfer.currency)}; a la consulta le seguirán faltando ${formatMoney(payment.pendingAmount - applied, transfer.currency)}.`;
    if (!window.confirm(`¿Conciliar con la consulta ${label}?\n\n${detail}`)) return;
    return run(async () => {
      const updated = await reconcileBankTransfer(transfer.id, payment.id, newOperationKey());
      onChanged(updated);
      showToast('success', covers ? `Consulta ${label} conciliada y aprobada.` : `Se aplicaron ${formatMoney(applied, transfer.currency)} a la consulta ${label}.`);
      // Solo se abre el comprobante si se pudo registrar la impresión.
      try {
        await registerAndDisplayReceipt(() => openReconciliationReceipt(updated, payment.id), onPrint);
      } catch (error) {
        const message = `Conciliación guardada, pero impresión pendiente: ${apiErrorMessage(error, 'seleccioná la toma para reintentar')}.`;
        setError(message);
        showToast('error', message);
      }
      setMode('VIEW');
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 no-print" onMouseDown={() => !busy && onClose()}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b bg-slate-50">
          <div className="flex items-center gap-2">
            <h3 className="font-bold text-slate-800">Transferencia</h3>
            <BankStatusBadge status={transfer.status} />
            {transfer.source === 'MOCK' && <span className="px-1.5 rounded bg-fuchsia-100 text-fuchsia-700 border border-fuchsia-200 text-[10px] font-bold">SIMULADA</span>}
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-slate-200" aria-label="Cerrar">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4">
          <div className="text-center">
            <div className="text-3xl font-black text-slate-900">{formatMoney(transfer.amount, transfer.currency)}</div>
            <div className="text-sm text-slate-600 mt-1">{transfer.senderName || 'Remitente no informado'}</div>
            {transfer.claims.length > 0 && available > 0 && (
              <div className="text-xs font-semibold text-sky-700 mt-1">
                Quedan {formatMoney(available, transfer.currency)} libres de este pago
              </div>
            )}
          </div>

          {transfer.status === BankTransferStatus.REVERSADA && (
            <div className="flex gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
              <AlertCircle className="w-5 h-5 shrink-0" />
              <span>
                El banco reversó esta transferencia{claims.length > 0 ? ' después de que fue tomada. Verificá el pago con quien la tomó.' : '. No se puede tomar.'}
              </span>
            </div>
          )}
          {transfer.status === BankTransferStatus.BLOQUEADA && (
            <div className="flex gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
              <AlertCircle className="w-5 h-5 shrink-0" />
              <span>{transfer.blockedReason || 'En revisión del administrador.'}</span>
            </div>
          )}

          {claims.length > 0 && (
            <div className="space-y-2">
              {claims.length > 1 && (
                <p className="text-xs font-bold text-slate-500 uppercase">Este pago se repartió en {claims.length} cobros</p>
              )}
              {claims.map((c) => {
                const selected = claim?.id === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    disabled={mode === 'VOID' || busy}
                    onClick={() => setSelectedClaimId(selected && claims.length > 1 ? null : c.id)}
                    className={`w-full text-left rounded-xl border-2 p-3 transition ${selected ? 'border-slate-800 bg-white' : 'border-slate-200 bg-slate-50 hover:border-slate-400'}`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="text-sm font-bold text-slate-900">{claimSummary(c)}</div>
                      {claims.length > 1 && <div className="text-sm font-black text-slate-900 shrink-0">{formatMoney(c.amount, transfer.currency)}</div>}
                    </div>
                    <div className="text-xs text-slate-500 mt-1">
                      Comprobante {c.receiptNumber} · impresión solicitada {c.printCount} {c.printCount === 1 ? 'vez' : 'veces'}
                      {c.note ? ` · “${c.note}”` : ''}
                    </div>
                    {c.matchStrength === 'DEBIL' && (
                      <div className="text-[11px] font-semibold text-amber-700 mt-1">
                        Conciliada solo por monto, sin evidencia que la respalde.
                      </div>
                    )}
                  </button>
                );
              })}
              {claims.length > 1 && !claim && (
                <p className="text-[11px] text-slate-500">Elegí un cobro para reimprimir o anular.</p>
              )}
            </div>
          )}

          <div>
            <Row label="Ingresó" value={formatDateTime(transfer.movementAt)} />
            <Row label="Banco de origen" value={transfer.senderBankName || 'No informado por el banco'} />
            <Row label="Canal" value={transfer.channel} />
            <Row label="Motivo" value={transfer.sipapReason} />
            <Row label="Ref. SIPAP" value={transfer.sipapReference} />
            <Row label="Concepto del remitente" value={transfer.senderNote} />
            <Row label="Documento del remitente" value={transfer.senderDoc} />
            <Row label="Cuenta del remitente" value={transfer.senderAccount} />
            <Row label="N° documento banco" value={transfer.bankDocNumber} />
            <Row label="Operación" value={transfer.txDescription || transfer.concept} />
          </div>

          {mode === 'VOID' && (
            <div className="space-y-2">
              {voidClaim && <p className="text-xs font-semibold text-red-800 rounded-lg bg-red-50 border border-red-200 p-2">Se anulará el comprobante {voidClaim.receiptNumber}, {formatMoney(voidClaim.amount, transfer.currency)} aplicado a {referenceText(voidClaim)}.</p>}
              {voidClaim && voidClaim.printCount > 0 && (
                <p className="text-xs text-amber-900 rounded-lg bg-amber-50 border border-amber-200 p-2">
                  Hay {voidClaim.printCount} {voidClaim.printCount === 1 ? 'solicitud de impresión registrada' : 'solicitudes de impresión registradas'} para este comprobante. Esto no confirma que salió papel; si se entregó una copia, gestioná su invalidez con el equipo.
                </p>
              )}
              <label className="text-sm font-semibold text-slate-700">Motivo de la anulación (obligatorio)</label>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={300} className="w-full p-2 border rounded-lg text-sm" placeholder="Ej: el cajero cargó un ticket equivocado" />
              <p className="text-xs text-slate-500">
                La toma queda en el historial como anulada, con tu usuario y el motivo.{voidClaim?.paymentId ? ' Si la consulta queda sin cubrir, vuelve a pendiente; la anulación se impide si ya se imprimió el ticket o se pagó en caja.' : ''}
              </p>
            </div>
          )}

          {mode === 'RELEASE' && (
            <div className="space-y-2">
              <label className="text-sm font-semibold text-slate-700">¿Por qué se libera? (obligatorio)</label>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={300} className="w-full p-2 border rounded-lg text-sm" placeholder="Ej: verificado con el banco, no es duplicado" />
            </div>
          )}

          {mode === 'RECONCILE' && (
            <div className="space-y-2">
              <h4 className="text-sm font-bold text-slate-700">Consultas que pueden corresponder a este pago</h4>
              {!candidates && !error && <Loader2 className="w-5 h-5 animate-spin text-slate-400" />}
              {candidates?.length === 0 && <p className="text-sm text-slate-500">No hay consultas pendientes cerca de esta fecha.</p>}
              {candidates?.map((p) => (
                <div key={p.id} className={`p-2 rounded-lg border text-sm ${p.match?.strength === 'FUERTE' ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-800 truncate">
                        {p.paymentRef || p.id.slice(0, 8)} · {p.collectorName || 'Cobrador'}
                      </div>
                      <div className="text-xs text-slate-500 truncate">
                        {p.clientName || p.clientCode || 'Cliente'} · {p.sourceBank || 'Banco'} · {formatDateTime(p.createdAt)}
                      </div>
                      <div className="text-xs text-slate-600 mt-0.5">
                        Falta cubrir {formatMoney(p.pendingAmount, transfer.currency)}
                        {p.allocatedAmount > 0 ? ` de ${formatMoney(p.amount, transfer.currency)}` : ''}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      {p.match && <MatchBadge match={p.match} />}
                      <button type="button" disabled={busy} onClick={() => void doReconcile(p)} className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-700 disabled:opacity-60">
                        Conciliar
                      </button>
                    </div>
                  </div>
                  {p.match && <p className="text-[11px] text-slate-600 mt-1">{p.match.reason}</p>}
                </div>
              ))}
            </div>
          )}

          {mode === 'HISTORY' && (
            <div className="space-y-3">
              {!history && !error && <Loader2 className="w-5 h-5 animate-spin text-slate-400" />}
              {history?.claims.map((c: BankClaim | null) =>
                c ? (
                  <div key={c.id} className={`p-2 rounded-lg border text-xs ${c.status === 'ANULADA' ? 'bg-red-50 border-red-200' : 'bg-slate-50'}`}>
                    <div className="font-semibold">
                      {c.receiptNumber} · {referenceText(c)} · {roleLabel(c.claimedByRole)} {(c.claimedByName || c.claimedByUsername || '').toUpperCase()} · {formatDateTime(c.claimedAt)}
                    </div>
                    {c.status === 'ANULADA' && (
                      <div className="text-red-700 mt-1">
                        Anulada por {c.voidedByName} {c.voidedAt ? `el ${formatDateTime(c.voidedAt)}` : ''}: {c.voidReason}
                      </div>
                    )}
                  </div>
                ) : null,
              )}
              <div className="space-y-1">
                {history?.audit.map((a) => (
                  <div key={a.id} className="text-[11px] text-slate-600 border-b border-slate-100 pb-1">
                    <b>{AUDIT_LABELS[a.action] || a.action}</b> · {a.actorUsername || a.userId} · {formatDateTime(a.timestamp)}
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="flex gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
              <AlertCircle className="w-5 h-5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2 px-5 py-4 border-t bg-slate-50">
          {mode === 'VOID' || mode === 'RELEASE' ? (
            <>
              <button type="button" onClick={() => { setMode('VIEW'); setVoidClaimId(null); }} disabled={busy} className="flex-1 py-2 rounded-xl border bg-white font-semibold text-slate-700">
                Volver
              </button>
              <button
                type="button"
                onClick={() => void (mode === 'VOID' ? doVoid() : doRelease())}
                disabled={busy || reason.trim().length < 10 || (mode === 'VOID' && !voidClaim)}
                className="flex-1 py-2 rounded-xl bg-red-600 text-white font-bold disabled:opacity-50 inline-flex items-center justify-center gap-2"
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                {mode === 'VOID' ? 'Confirmar anulación' : 'Confirmar liberación'}
              </button>
            </>
          ) : (
            <>
              {canReprint && (
                <button type="button" onClick={() => void reprint()} disabled={busy} className="px-3 py-2 rounded-xl border bg-white text-sm font-semibold text-slate-700 inline-flex items-center gap-2">
                  <Printer className="w-4 h-4" /> Reimprimir
                </button>
              )}
              {isAdmin && claim && claim.status === 'ACTIVA' && (
                <button type="button" onClick={() => { setVoidClaimId(claim.id); setReason(''); setMode('VOID'); }} className="px-3 py-2 rounded-xl border border-red-200 bg-red-50 text-sm font-semibold text-red-700 inline-flex items-center gap-2">
                  <ShieldOff className="w-4 h-4" /> Anular toma
                </button>
              )}
              {isAdmin && transfer.status === BankTransferStatus.BLOQUEADA && (
                <button type="button" onClick={() => setMode('RELEASE')} className="px-3 py-2 rounded-xl border border-amber-200 bg-amber-50 text-sm font-semibold text-amber-800 inline-flex items-center gap-2">
                  <Unlock className="w-4 h-4" /> Liberar
                </button>
              )}
              {canReconcile && (
                <button type="button" onClick={() => setMode(mode === 'RECONCILE' ? 'VIEW' : 'RECONCILE')} className="px-3 py-2 rounded-xl border border-indigo-200 bg-indigo-50 text-sm font-semibold text-indigo-700 inline-flex items-center gap-2">
                  <Link2 className="w-4 h-4" /> {user.role === UserRole.COBRADOR ? 'Conciliar con mi consulta' : 'Conciliar con consulta'}
                </button>
              )}
              {isAdmin && (
                <button type="button" onClick={() => setMode(mode === 'HISTORY' ? 'VIEW' : 'HISTORY')} className="px-3 py-2 rounded-xl border bg-white text-sm font-semibold text-slate-700 inline-flex items-center gap-2">
                  <History className="w-4 h-4" /> Historial
                </button>
              )}
              <button type="button" onClick={onClose} className="ml-auto px-4 py-2 rounded-xl bg-slate-800 text-white text-sm font-semibold">
                Cerrar
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
