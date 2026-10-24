import React from 'react';
import { Loader2, Printer } from 'lucide-react';

/**
 * Se abre al cerrar el diálogo de impresión de Windows. El navegador no informa si la persona
 * imprimió o canceló: solo un "Sí" registra el ticket como impreso. No sale en el papel.
 */
export const PrintConfirmDialog = ({
  label,
  busy,
  onPrinted,
  onPrintAgain,
  onNotPrinted,
  allowReprint = false,
}: {
  label: string;
  busy: boolean;
  onPrinted: () => void;
  onPrintAgain: () => void;
  onNotPrinted: () => void;
  allowReprint?: boolean;
}) => (
  <div
    className="no-print print:hidden fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
    role="dialog"
    aria-modal="true"
    aria-labelledby="print-confirm-title"
  >
    <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl">
      <h2 id="print-confirm-title" className="flex items-center gap-2 text-lg font-bold text-slate-800">
        <Printer className="h-5 w-5" /> ¿Salió impreso?
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        {label}. Solo queda registrado como impreso si respondés que sí; si cancelaste o la impresora falló, elegí otra opción.
      </p>
      <div className="mt-4 grid gap-2">
        <button
          type="button"
          onClick={onPrinted}
          disabled={busy}
          autoFocus
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-green-600 py-3 text-sm font-bold text-white hover:bg-green-700 disabled:opacity-60"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} {busy ? 'Registrando…' : 'Sí, salió impreso'}
        </button>
        {allowReprint && <button
          type="button"
          onClick={onPrintAgain}
          disabled={busy}
          className="rounded-xl border border-slate-300 bg-white py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          Volver a imprimir
        </button>}
        {!allowReprint && <p className="text-xs text-slate-600">Para una nueva emisión, solicitá la reimpresión a ADMIN.</p>}
        <button
          type="button"
          onClick={onNotPrinted}
          disabled={busy}
          className="rounded-xl py-2 text-sm font-semibold text-slate-500 hover:text-slate-800 disabled:opacity-60"
        >
          No se imprimió
        </button>
      </div>
    </div>
  </div>
);
