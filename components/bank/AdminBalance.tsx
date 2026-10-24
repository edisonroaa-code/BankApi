import React, { useState } from 'react';
import { Eye, EyeOff, Loader2, Wallet } from 'lucide-react';
import { BankBalance } from '../../types';
import { apiErrorMessage, fetchBankBalance } from '../../services/bankTransfers';
import { formatMoney, formatTime } from './bankUi';

/**
 * Saldo de la cuenta Atlas, solo para el admin y solo cuando lo pide (decision del 2026-10-07).
 * No se actualiza solo ni viaja por las salas en vivo que comparten caja y cobradores; al cambiar
 * de pantalla se vuelve a ocultar.
 */
export const AdminBalance = () => {
  const [balance, setBalance] = useState<BankBalance | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = async () => {
    setLoading(true);
    setError(null);
    try {
      setBalance(await fetchBankBalance());
    } catch (e) {
      setError(apiErrorMessage(e, 'No se pudo consultar el saldo.'));
    } finally {
      setLoading(false);
    }
  };

  if (!balance) {
    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void show()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />} Ver saldo
        </button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    );
  }

  const { balance: b } = balance;
  return (
    <div className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1 rounded-full border border-indigo-200 bg-indigo-50 text-xs text-indigo-900">
      <Wallet className="w-3.5 h-3.5" />
      <span>
        Saldo <b>{formatMoney(b.saldo, b.moneda)}</b> · disponible <b>{formatMoney(b.saldoDisponible, b.moneda)}</b>
      </span>
      <span className="text-indigo-600">consultado {formatTime(balance.consultedAt)}</span>
      {balance.simulated && <span className="px-1.5 rounded bg-fuchsia-100 text-fuchsia-700 border border-fuchsia-200 text-[10px] font-bold">SIMULADO</span>}
      <button type="button" onClick={() => setBalance(null)} className="inline-flex items-center gap-1 text-indigo-700 hover:underline">
        <EyeOff className="w-3.5 h-3.5" /> Ocultar
      </button>
    </div>
  );
};
