import React from 'react';
import { BankReceipt } from '../types';
import { parseDbTimestamp } from '../services/date';
import { bankReceiptSourceLabel, bankReceiptTitle } from '../services/receipt-registration';
import { loadCompanyProfile } from '../services/company-profile';

const roleLabel = (role: string) =>
  role === 'CAJERO' ? 'CAJA' : role === 'COBRADOR' ? 'COBRADOR' : role === 'ADMIN' ? 'ADMIN' : 'SUPERVISOR';

const referenceLabel = (receipt: BankReceipt) =>
  receipt.referenceType === 'TICKET'
    ? `TICKET N° ${receipt.referenceValue}`
    : receipt.referenceType === 'CLIENTE'
      ? `CLIENTE N° ${receipt.referenceValue}`
      : `CONSULTA ${receipt.paymentRef ?? receipt.referenceValue.slice(0, 8)}`;

const formatDate = (value: string) =>
  new Intl.DateTimeFormat('es-PY', { timeZone: 'America/Asuncion', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    parseDbTimestamp(value) ?? new Date(value),
  );

const formatTime = (value: string) =>
  new Intl.DateTimeFormat('es-PY', { timeZone: 'America/Asuncion', hour: '2-digit', minute: '2-digit', hour12: false }).format(
    parseDbTimestamp(value) ?? new Date(value),
  );

/** Comprobante de toma de una transferencia del banco. Usa el mismo contenedor de impresion que el ticket de consultas. */
export const BankTransferReceipt = ({ receipt }: { receipt: BankReceipt | null }) => {
  if (!receipt) return null;
  const who = (receipt.claimedByName || receipt.claimedByUsername || '').toUpperCase();
  const company = loadCompanyProfile();
  return (
    <div id="printable-ticket-container" className="hidden print:block p-2 bg-white text-black">
      {receipt.voided && (
        <div className="text-center mb-2 border-2 border-black py-1 font-bold uppercase text-sm print-border-black">ANULADO</div>
      )}
      {!receipt.voided && receipt.printCount > 1 && (
        <div className="text-center mb-2 border-2 border-black py-1 font-bold uppercase text-sm print-border-black">
          REIMPRESIÓN N° {receipt.printCount - 1}
        </div>
      )}
      <div className="text-center mb-4 border-b-2 border-black pb-2 print-border-black">
        <h1 className="text-xl font-black uppercase tracking-tight">{company.companyName}</h1>
        {company.companyRuc && <p className="text-[11px] font-bold uppercase">RUC: {company.companyRuc}</p>}
        <p className="text-xs font-bold uppercase mt-1">{bankReceiptTitle(receipt.referenceType)}</p>
        <p className="text-sm font-black mt-1">{receipt.receiptNumber}</p>
      </div>
      <div className="text-sm space-y-1 mb-4 font-bold">
        <div className="flex justify-between">
          <span>FECHA:</span>
          <span>{formatDate(receipt.claimedAt)}</span>
        </div>
        <div className="flex justify-between">
          <span>HORA:</span>
          <span>{formatTime(receipt.claimedAt)}</span>
        </div>
        <div className="border-b border-black my-2 print-border-black"></div>
        <p><strong>FUENTE:</strong> {bankReceiptSourceLabel(receipt.source)}</p>
        <p>{referenceLabel(receipt)}</p>
        {/* En una consulta conciliada el código de cliente va siempre y bien visible: si falta el dato, se ve el guion. */}
        {(receipt.referenceType === 'CONSULTA' || receipt.clientCode) && (
          <p className="text-base font-black">
            CÓD. CLIENTE: {receipt.clientCode || '—'}
          </p>
        )}
        {receipt.clientName && (
          <p>
            <strong>CLIENTE:</strong> {receipt.clientName.slice(0, 24)}
          </p>
        )}
        {receipt.referenceType === 'CONSULTA' && receipt.collectorName && (
          <p>
            <strong>COBRADOR:</strong> {receipt.collectorName.toUpperCase().slice(0, 24)}
          </p>
        )}
        <p>
          <strong>REMITENTE:</strong> {(receipt.senderName || 'NO INFORMADO').slice(0, 24)}
        </p>
        <p>
          <strong>DOC. BANCO:</strong> {receipt.bankDocNumber || '--'}
        </p>
        <p>
          <strong>INGRESO:</strong> {formatDate(receipt.movementAt)} {formatTime(receipt.movementAt)}
        </p>
      </div>
      <div className="text-right text-2xl font-black border-t-2 border-b-2 border-black py-2 mb-4 print-border-black">
        {new Intl.NumberFormat('es-PY', { style: 'currency', currency: receipt.currency || 'PYG' }).format(receipt.amount)}
      </div>
      {/* Cobro parcial: en el ticket tiene que verse que la transferencia era por mas. */}
      {receipt.transferAmount > receipt.amount && (
        <p className="text-[10px] text-center font-bold mb-3">
          PARTE DE UNA TRANSFERENCIA DE{' '}
          {new Intl.NumberFormat('es-PY', { style: 'currency', currency: receipt.currency || 'PYG' }).format(receipt.transferAmount)}
        </p>
      )}
      <div className="text-[10px] text-center font-bold">
        <p>
          TOMADO POR: {roleLabel(receipt.claimedByRole)} {who}
        </p>
        <p className="mt-2 uppercase">*** DOCUMENTO INTERNO ***</p>
        <p>{company.ticketFooter}</p>
      </div>
    </div>
  );
};
