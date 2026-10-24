import { UserRole } from '../users/entities/user.entity';

/**
 * Salas del namespace /realtime. Cada rol entra solo a las que necesita:
 * - payments: eventos de consultas de cobradores.
 * - bank-feed:full: transferencias del banco con datos completos del remitente.
 * - bank-feed:masked: las mismas transferencias con documento y cuenta enmascarados.
 * - bank-feed:demand: sockets con un panel de transferencias ABIERTO Y VISIBLE. Las dos salas de
 *   arriba dicen quien puede recibir datos; esta dice si alguien esta mirando. El sondeo al banco
 *   cuenta solo esta: tener la app abierta en otra pantalla no consulta al banco.
 *
 * El cobrador ve datos completos por decision del dueno del sistema: los necesita para reconocer
 * a su cliente al conciliar. La caja y el supervisor los ven enmascarados: la caja cobra con el
 * nombre y el monto, y el supervisor solo mira (decision del 2026-10-07).
 */
export const ROOMS = {
  payments: 'payments',
  bankFull: 'bank-feed:full',
  bankMasked: 'bank-feed:masked',
  bankDemand: 'bank-feed:demand',
} as const;

export const BANK_FEED_FULL_ROLES: string[] = [UserRole.ADMIN, UserRole.COBRADOR];
export const BANK_FEED_MASKED_ROLES: string[] = [UserRole.CAJERO, UserRole.SUPERVISOR];
const PAYMENTS_ROLES: string[] = [UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.COBRADOR];

export const roomsForRole = (role: string): string[] => {
  const rooms: string[] = [];
  if (PAYMENTS_ROLES.includes(role)) rooms.push(ROOMS.payments);
  if (BANK_FEED_FULL_ROLES.includes(role)) rooms.push(ROOMS.bankFull);
  if (BANK_FEED_MASKED_ROLES.includes(role)) rooms.push(ROOMS.bankMasked);
  return rooms;
};

/** Quien ve datos completos del remitente (documento y cuenta sin enmascarar). */
export const seesFullSenderData = (role: string | undefined) => !!role && BANK_FEED_FULL_ROLES.includes(role);

/** Quien puede abrir un panel de transferencias y, con eso, hacer que el feed consulte al banco. */
export const canOpenBankPanel = (role: string | undefined) =>
  !!role && (BANK_FEED_FULL_ROLES.includes(role) || BANK_FEED_MASKED_ROLES.includes(role));
