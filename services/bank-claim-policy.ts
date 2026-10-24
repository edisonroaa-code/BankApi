import type { UserRole } from "../types";

/** Refleja el permiso del endpoint POST /bank-transfers/:id/claim. */
export const canDirectlyClaimBankTransfer = (
  role: UserRole | string,
): boolean => role === "CAJERO" || role === "ADMIN";

/** La caja y los tickets operan exclusivamente en guaraníes. */
export const isSupportedBankCurrency = (currency: string | null | undefined): boolean =>
  currency?.trim().toUpperCase() === "PYG";
