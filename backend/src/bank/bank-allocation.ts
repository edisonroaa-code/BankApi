import { BankTransferStatus } from './entities/bank-transfer.entity';

/**
 * Los montos se comparan en centavos enteros: comparar numeric de Postgres con floats de
 * JavaScript deja diferencias de 0,000001 que romperian el saldo.
 */
export const cents = (value: number | string | null | undefined) => Math.round(Number(value ?? 0) * 100);

export const fromCents = (value: number) => value / 100;

export type AllocatableRow = { amount: number | string; allocatedAmount: number | string };

/** Saldo libre de una transferencia (o de una consulta), en centavos. */
export const remainingCents = (row: AllocatableRow) => cents(row.amount) - cents(row.allocatedAmount);

export const isFullyAllocated = (row: AllocatableRow) => remainingCents(row) <= 0;

/**
 * Estado derivado del saldo. Reversada y bloqueada mandan sobre el saldo: son estados del banco
 * o de una revision, no de cuanto se tomo.
 */
export const statusFromAllocation = (row: AllocatableRow & { status: BankTransferStatus }): BankTransferStatus => {
  if (row.status === BankTransferStatus.REVERSADA || row.status === BankTransferStatus.BLOQUEADA) return row.status;
  const allocated = cents(row.allocatedAmount);
  if (allocated <= 0) return BankTransferStatus.DISPONIBLE;
  return allocated >= cents(row.amount) ? BankTransferStatus.TOMADA : BankTransferStatus.PARCIAL;
};

/** Estados sobre los que todavia se puede tomar dinero. */
export const isClaimable = (row: AllocatableRow & { status: BankTransferStatus }) =>
  row.status !== BankTransferStatus.REVERSADA && row.status !== BankTransferStatus.BLOQUEADA && remainingCents(row) > 0;

export const formatMoney = (value: number, currency = 'PYG') =>
  new Intl.NumberFormat('es-PY', { style: 'currency', currency, maximumFractionDigits: currency === 'PYG' ? 0 : 2 }).format(value);

/**
 * Cuanto tomar: lo pedido, o todo el saldo libre si no se pidio nada (el caso normal, una
 * transferencia que paga un solo cobro). Devuelve el error a mostrar si lo pedido no entra.
 */
export const resolveAmountToClaim = (
  requested: number | undefined | null,
  available: number,
  currency = 'PYG',
): { cents: number } | { error: string } => {
  if (requested === undefined || requested === null) return { cents: available };
  const asked = cents(requested);
  if (!Number.isFinite(asked) || asked <= 0) return { error: 'El monto a tomar debe ser mayor a cero.' };
  if (asked > available) {
    return { error: `Solo quedan ${formatMoney(fromCents(available), currency)} libres en esta transferencia.` };
  }
  return { cents: asked };
};
