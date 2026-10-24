import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Loader2, X } from 'lucide-react';
import { BankReceipt, BankTransfer, BankTransferStatus, User } from '../../types';
import { apiErrorMessage, claimBankTransfer, newOperationKey, openBankReceipt } from '../../services/bankTransfers';
import { registerAndDisplayReceipt } from '../../services/receipt-registration';
import { claimsSummary, formatDateTime, formatMoney, roleLabel } from './bankUi';

/**
 * Confirmacion de toma: "¿Desea tomar este pago?" + numero de ticket o cliente.
 * Quien toma sale siempre de la sesion; el servidor decide si otro la tomo antes.
 */
export const TakeTransferModal = ({
  transfer,
  user,
  onClose,
  onTaken,
}: {
  transfer: BankTransfer;
  user: User;
  onClose: () => void;
  onTaken: (transfer: BankTransfer, printedReceipt: BankReceipt | null, receiptNumber: string) => void;
}) => {
  const [referenceType, setReferenceType] = useState<'TICKET' | 'CLIENTE'>('TICKET');
  const [referenceValue, setReferenceValue] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Toma parcial: apagada por defecto, porque lo normal es que la transferencia pague un solo cobro.
  const [splitting, setSplitting] = useState(false);
  const [partialAmount, setPartialAmount] = useState('');
  // Aviso de referencia ya cobrada: lo devuelve el servidor y decide quien esta cobrando.
  const [reuseWarning, setReuseWarning] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Una clave por apertura: si la red falla y se reintenta, el servidor no crea una segunda toma.
  const operationKey = useMemo(() => newOperationKey(), [transfer.id]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  // El panel reemplaza `transfer` en vivo: si otro se lleva todo el saldo, el modal se bloquea.
  const available = transfer.availableAmount;
  const takenByOther =
    available <= 0 ||
    transfer.status === BankTransferStatus.REVERSADA ||
    transfer.status === BankTransferStatus.BLOQUEADA;
  const partiallyTaken = transfer.claims.length > 0 && available > 0;

  const submit = async (confirmReuse = false) => {
    if (takenByOther || submitting) return;
    if (!referenceValue.trim()) {
      setError(`Ingresá el número de ${referenceType === 'TICKET' ? 'ticket' : 'cliente'}.`);
      inputRef.current?.focus();
      return;
    }
    const asked = splitting ? Number(partialAmount.replace(/[^0-9]/g, '')) : null;
    if (splitting && (!asked || asked <= 0)) {
      setError('Escribí cuánto de esta transferencia estás cobrando.');
      return;
    }
    if (asked && asked > available) {
      setError(`Solo quedan ${formatMoney(available, transfer.currency)} libres en esta transferencia.`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await claimBankTransfer(transfer.id, {
        referenceType,
        referenceValue: referenceValue.trim(),
        idempotencyKey: operationKey,
        note: note.trim() || undefined,
        amount: asked ?? undefined,
        confirmReuse: confirmReuse || undefined,
      });
      const newClaim = result.transfer.claims.find((claim) => claim.receiptNumber === result.receipt.receiptNumber);
      try {
        if (!newClaim) throw new Error('La toma no vino identificada en la respuesta.');
        await registerAndDisplayReceipt(
          () => openBankReceipt(transfer.id, newClaim.id),
          (receipt) => onTaken(result.transfer, receipt, result.receipt.receiptNumber),
        );
      } catch {
        // La toma existe, pero el comprobante no se pudo abrir: se imprime desde Mis tomas.
        onTaken(result.transfer, null, result.receipt.receiptNumber);
      }
    } catch (e: any) {
      // El servidor avisa que esa referencia ya tiene un cobro: puede ser otra parte del mismo.
      if (e?.response?.data?.confirmable) setReuseWarning(apiErrorMessage(e, 'Esa referencia ya tiene un cobro.'));
      else setError(apiErrorMessage(e, 'No se pudo tomar la transferencia.'));
    } finally {
      setSubmitting(false);
    }
  };

  const who = (user.name || user.username).toUpperCase();

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 no-print" onMouseDown={() => !submitting && onClose()}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b bg-slate-50">
          <h3 className="font-bold text-slate-800">¿Desea tomar este pago?</h3>
          <button type="button" onClick={onClose} disabled={submitting} className="p-1 rounded hover:bg-slate-200" aria-label="Cerrar">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="text-center">
            <div className="text-3xl font-black text-slate-900">{formatMoney(transfer.amount, transfer.currency)}</div>
            {partiallyTaken && (
              <div className="text-xs font-semibold text-sky-700 mt-1">
                Ya cobrado en parte · quedan {formatMoney(available, transfer.currency)} libres
              </div>
            )}
            <div className="text-sm text-slate-600 mt-1">
              {transfer.senderName || 'Remitente no informado'}
              {transfer.senderBankName ? ` · ${transfer.senderBankName}` : ''}
            </div>
            <div className="text-xs text-slate-400 mt-1">
              {formatDateTime(transfer.movementAt)} · Doc. banco {transfer.bankDocNumber || '--'}
            </div>
            {transfer.senderNote && <div className="text-xs text-slate-500 mt-2 italic">“{transfer.senderNote}”</div>}
          </div>

          {takenByOther ? (
            <div className="flex gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
              <AlertCircle className="w-5 h-5 shrink-0" />
              <span>
                {transfer.claims.length > 0 ? `Ya no está disponible: ${claimsSummary(transfer)}.` : 'Esta transferencia ya no está disponible.'}
              </span>
            </div>
          ) : (
            <>
              <div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2 text-sm text-blue-900">
                Vas a tomar este pago como: <b>{who}</b> ({roleLabel(user.role)})
              </div>

              <div className="flex rounded-lg border overflow-hidden text-sm font-semibold">
                {(['TICKET', 'CLIENTE'] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setReferenceType(type)}
                    className={`flex-1 py-2 ${referenceType === type ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                  >
                    {type === 'TICKET' ? 'N° de ticket' : 'N° de cliente'}
                  </button>
                ))}
              </div>

              <input
                ref={inputRef}
                value={referenceValue}
                onChange={(e) => setReferenceValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void submit()}
                maxLength={40}
                inputMode="numeric"
                placeholder={referenceType === 'TICKET' ? 'Ej: 4512' : 'Ej: 1203'}
                className="w-full text-center text-2xl font-bold tracking-wide p-3 border-2 rounded-xl focus:outline-none focus:border-slate-800"
              />

              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={200}
                placeholder="Observación (opcional)"
                className="w-full text-sm p-2 border rounded-lg"
              />

              {/* El pago partido es la excepcion: hay que pedirlo a proposito. */}
              {splitting ? (
                <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 space-y-2">
                  <label className="text-xs font-bold text-sky-900 uppercase">Cobro solo una parte</label>
                  <input
                    value={partialAmount}
                    onChange={(e) => setPartialAmount(e.target.value.replace(/[^0-9]/g, ''))}
                    inputMode="numeric"
                    placeholder="Monto a cobrar"
                    className="w-full text-center text-xl font-bold p-2 border-2 border-sky-300 rounded-lg focus:outline-none focus:border-sky-600"
                  />
                  <p className="text-[11px] text-sky-800">
                    El resto queda libre para otro cobro. Máximo {formatMoney(available, transfer.currency)}.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setSplitting(false);
                      setPartialAmount('');
                    }}
                    className="text-[11px] text-sky-700 underline"
                  >
                    Cobrar el total
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => setSplitting(true)} className="text-xs text-slate-500 underline">
                  Este pago cubre solo una parte del cobro
                </button>
              )}
            </>
          )}

          {reuseWarning && (
            <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900 space-y-2">
              <div className="flex gap-2">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <span>{reuseWarning}</span>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setReuseWarning(null)} className="flex-1 py-1.5 rounded-lg border bg-white text-xs font-semibold">
                  Revisar
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setReuseWarning(null);
                    void submit(true);
                  }}
                  className="flex-1 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-bold"
                >
                  Sí, es otra parte del mismo cobro
                </button>
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

        <div className="flex gap-2 px-5 py-4 border-t bg-slate-50">
          <button type="button" onClick={onClose} disabled={submitting} className="flex-1 py-2.5 rounded-xl border bg-white font-semibold text-slate-700 hover:bg-slate-100">
            {takenByOther ? 'Cerrar' : 'Cancelar'}
          </button>
          {!takenByOther && (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={submitting || !!reuseWarning}
              className="flex-1 py-2.5 rounded-xl bg-emerald-600 text-white font-bold hover:bg-emerald-700 disabled:opacity-60 inline-flex items-center justify-center gap-2"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Tomar pago
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
