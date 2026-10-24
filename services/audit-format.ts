/**
 * Auditoría legible: cada registro se muestra como una frase con datos concretos (montos, clientes,
 * comprobantes, motivos) en lugar de códigos y JSON. El código y los datos crudos siguen
 * disponibles aparte, para una revisión técnica.
 */
import type { AuditLog } from '../types';

type Meta = Record<string, any>;

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  PAYMENT_CREATED: 'Consulta cargada',
  PAYMENT_UPDATED: 'Consulta editada',
  PAYMENT_SENT_TO_REVIEW: 'Consulta enviada a revisión',
  PAYMENT_REVIEW_CLAIMED: 'Consulta tomada para revisar',
  PAYMENT_REVIEW_RELEASED: 'Consulta liberada',
  PAYMENT_PROOF_VIEWED: 'Comprobante consultado',
  PAYMENT_CONFIRMED_MANUAL: 'Ingreso aprobado a mano',
  PAYMENT_MATCH_CONFIRMED: 'Ingreso por coincidencia',
  PAYMENT_AUTO_CONFIRMED: 'Ingreso automático',
  PAYMENT_REJECTED: 'No ingresó',
  PAYMENT_DECISION_UNDONE: 'Decisión anulada',
  PAYMENT_PRINT_OPENED: 'Ticket abierto para imprimir',
  PAYMENT_PRINTED: 'Ticket impreso',
  PAYMENT_CASH_PAID: 'Pago en caja efectuado',
  PAYMENT_BANK_RECONCILED: 'Conciliada con el banco',
  PAYMENT_BANK_RECONCILIATION_VOIDED: 'Conciliación anulada',
  BANK_TRANSFER_CLAIMED: 'Transferencia tomada',
  BANK_TRANSFER_CLAIM_CONFLICT: 'Intento de toma rechazado',
  BANK_TRANSFER_CLAIM_VOIDED: 'Toma anulada',
  BANK_TRANSFER_RECEIPT_PRINT_OPENED: 'Comprobante abierto para imprimir',
  BANK_TRANSFER_RECEIPT_PRINTED: 'Comprobante impreso',
  BANK_CLAIM_REVIEWED: 'Conciliación revisada',
  BANK_TRANSFER_REVERSED: 'Transferencia reversada por el banco',
  BANK_TRANSFER_BLOCKED: 'Transferencia bloqueada',
  BANK_TRANSFER_RELEASED: 'Transferencia liberada',
  MATCHING_TRIGGERED: 'Conciliación automática ejecutada',
  MOVEMENTS_IMPORTED: 'Movimientos importados',
  USER_CREATED: 'Usuario creado',
  USER_UPDATED: 'Usuario modificado',
  USER_DELETED: 'Usuario eliminado',
  INITIAL_ADMIN_PROVISIONED: 'Primer administrador creado',
  ADMIN_PASSWORD_MAINTENANCE_RESET: 'Clave de administrador restablecida',
};

/** Filtro de acciones agrupado por tema, para buscar en la auditoría. */
export const AUDIT_ACTION_GROUPS: Array<{ group: string; actions: string[] }> = [
  { group: 'Consultas', actions: ['PAYMENT_CREATED', 'PAYMENT_UPDATED', 'PAYMENT_REVIEW_CLAIMED', 'PAYMENT_REVIEW_RELEASED', 'PAYMENT_PROOF_VIEWED', 'PAYMENT_CONFIRMED_MANUAL', 'PAYMENT_REJECTED', 'PAYMENT_DECISION_UNDONE'] },
  { group: 'Tickets y caja', actions: ['PAYMENT_PRINT_OPENED', 'PAYMENT_PRINTED', 'PAYMENT_CASH_PAID'] },
  { group: 'Banco (Atlas)', actions: ['PAYMENT_BANK_RECONCILED', 'PAYMENT_BANK_RECONCILIATION_VOIDED', 'BANK_TRANSFER_CLAIMED', 'BANK_TRANSFER_CLAIM_CONFLICT', 'BANK_TRANSFER_CLAIM_VOIDED', 'BANK_TRANSFER_RECEIPT_PRINT_OPENED', 'BANK_TRANSFER_RECEIPT_PRINTED', 'BANK_CLAIM_REVIEWED', 'BANK_TRANSFER_REVERSED', 'BANK_TRANSFER_BLOCKED', 'BANK_TRANSFER_RELEASED'] },
  { group: 'Usuarios', actions: ['USER_CREATED', 'USER_UPDATED', 'USER_DELETED', 'INITIAL_ADMIN_PROVISIONED', 'ADMIN_PASSWORD_MAINTENANCE_RESET'] },
  { group: 'Sistema anterior', actions: ['PAYMENT_SENT_TO_REVIEW', 'PAYMENT_MATCH_CONFIRMED', 'PAYMENT_AUTO_CONFIRMED', 'MATCHING_TRIGGERED', 'MOVEMENTS_IMPORTED'] },
];

/** Un código sin etiqueta conocida igual se lee: "SOME_NEW_EVENT" → "Some new event". */
export const auditActionLabel = (code: string): string => {
  if (AUDIT_ACTION_LABELS[code]) return AUDIT_ACTION_LABELS[code];
  const words = code.toLowerCase().split('_').filter(Boolean).join(' ');
  return words ? words[0].toUpperCase() + words.slice(1) : code;
};

const STATE_LABELS: Record<string, string> = {
  PENDIENTE_VERIFICACION: 'Pendiente',
  EN_REVISION: 'En revisión',
  CONFIRMADO: 'Ingreso (banco)',
  CONFIRMADO_MANUAL: 'Ingreso (manual)',
  RECHAZADO: 'No ingresó',
};

export const paymentStateLabel = (state?: string | null): string => (state ? STATE_LABELS[state] ?? state : '—');

const ROLE_LABELS: Record<string, string> = { ADMIN: 'administrador', SUPERVISOR: 'supervisor', COBRADOR: 'cobrador', CAJERO: 'caja' };
const roleLabel = (role?: string | null) => (role ? ROLE_LABELS[role] ?? role.toLowerCase() : 'sin rol');

export const formatAuditMoney = (value: unknown, currency?: string | null): string => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  const code = (currency || 'PYG').toUpperCase();
  return code === 'PYG' ? `Gs. ${new Intl.NumberFormat('es-PY').format(amount)}` : `${code} ${new Intl.NumberFormat('es-PY').format(amount)}`;
};

const formatTime = (value: unknown) => {
  const date = new Date(String(value));
  return Number.isNaN(date.getTime())
    ? String(value)
    : new Intl.DateTimeFormat('es-PY', { timeZone: 'America/Asuncion', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
};

const formatDateTime = (value: unknown) => {
  const date = new Date(String(value));
  return Number.isNaN(date.getTime())
    ? String(value)
    : new Intl.DateTimeFormat('es-PY', { timeZone: 'America/Asuncion', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
};

export const parseAuditMetadata = (raw?: string | null): Meta | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const depositBank = (isAtlasAccount: unknown) =>
  isAtlasAccount === true ? 'Atlas' : isAtlasAccount === false ? 'BNF' : 'sin elegir';

const reference = (type?: string, value?: string) =>
  type === 'TICKET' ? `el ticket N° ${value}` : type === 'CLIENTE' ? `el cliente N° ${value}` : type === 'CONSULTA' ? 'una consulta' : value ? `la referencia ${value}` : 'una referencia';

const EVIDENCE_LABELS: Record<string, string> = {
  REFERENCIA: 'referencia',
  CONCEPTO: 'concepto',
  CUENTA_CONOCIDA: 'cuenta conocida',
  NOMBRE: 'nombre',
  MONTO: 'monto',
  MONTO_PARCIAL: 'monto parcial',
  CERCANIA: 'hora cercana',
  BANCO: 'banco de origen',
  FECHA: 'fecha cercana a la carga',
  REFERENCIA_PARCIAL: 'terminación de referencia (parcial)',
};

const STRENGTH_LABELS: Record<string, string> = { FUERTE: 'fuerte', MEDIA: 'media', DEBIL: 'débil' };

const evidence = (value: unknown) => {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return list.map((item) => EVIDENCE_LABELS[String(item).trim()] ?? String(item).trim().toLowerCase()).filter(Boolean).join(', ');
};

const CONFLICT_LABELS: Record<string, string> = {
  TOMADA: 'ya estaba tomada',
  REVERSADA: 'el banco la había reversado',
  BLOQUEADA: 'estaba bloqueada por posible duplicado',
  MONEDA_NO_SOPORTADA: 'no era en guaraníes',
  REFERENCIA_USADA: 'esa referencia ya tenía un cobro',
  SALDO_INSUFICIENTE: 'no alcanzaba el saldo libre',
  CARRERA: 'otra persona la tomó en el mismo momento',
};

const PAYMENT_FIELDS: Record<string, string> = {
  amount: 'monto',
  paymentRef: 'referencia',
  clientCode: 'código de cliente',
  clientName: 'cliente',
  sourceBank: 'banco de origen',
  isAtlasAccount: 'banco de depósito',
};

const USER_FIELDS: Record<string, string> = {
  name: 'el nombre',
  username: 'el usuario',
  password: 'la clave',
  role: 'el rol',
  isActive: 'el estado (activo/inactivo)',
};

const fieldValue = (field: string, value: unknown) =>
  field === 'isAtlasAccount'
    ? depositBank(value)
    : value === null || value === undefined || value === ''
      ? '(vacío)'
      : field === 'amount'
        ? formatAuditMoney(value)
        : String(value);

const withReason = (reason: unknown) => (typeof reason === 'string' && reason.trim() ? ` Motivo: «${reason.trim()}».` : '');

/** Frase principal del registro. Sin metadatos (por ejemplo, un cobrador mirando un pago ajeno) igual dice qué pasó. */
export const describeAudit = (log: Pick<AuditLog, 'action' | 'metadata' | 'beforeState' | 'afterState'> & Partial<AuditLog>): string => {
  const m = parseAuditMetadata(log.metadata) ?? {};
  const money = (value: unknown) => formatAuditMoney(value, log.payment?.currency ?? log.bankTransfer?.currency);
  switch (log.action) {
    case 'PAYMENT_CREATED':
      return `Cargó la consulta${m.amount !== undefined ? ` por ${money(m.amount)}` : ''}${m.ref ? `, referencia ${m.ref}` : ''}.`;
    case 'PAYMENT_UPDATED': {
      const before: Meta = m.before ?? {};
      const after: Meta = m.after ?? {};
      const changes = Object.keys(PAYMENT_FIELDS)
        .filter((field) => after[field] !== undefined && String(after[field] ?? '') !== String(before[field] ?? ''))
        .map((field) => `${PAYMENT_FIELDS[field]}: ${fieldValue(field, before[field])} → ${fieldValue(field, after[field])}`);
      return changes.length ? `Cambió ${changes.join('; ')}.` : 'Guardó la consulta sin cambios en sus datos.';
    }
    case 'PAYMENT_SENT_TO_REVIEW':
      return 'La consulta pasó a revisión.';
    case 'PAYMENT_REVIEW_CLAIMED':
      return `Tomó la consulta para revisarla${m.expiresAt ? ` (reservada hasta las ${formatTime(m.expiresAt)})` : ''}.`;
    case 'PAYMENT_REVIEW_RELEASED':
      return 'Liberó la consulta sin decidir.';
    case 'PAYMENT_PROOF_VIEWED':
      return `Abrió el comprobante que adjuntó el cobrador${m.bank ? ` (enviado desde ${m.bank})` : ''}.`;
    case 'PAYMENT_CONFIRMED_MANUAL':
      return `Aprobó el ingreso a mano${m.amount !== undefined ? ` por ${money(m.amount)}` : ''}, depósito en ${depositBank(m.isAtlasAccount)}.${
        m.claimedAmountMatch ? ' Había una transferencia del banco ya tomada por el mismo monto.' : ''
      }${withReason(m.reason)}`;
    case 'PAYMENT_MATCH_CONFIRMED':
      return 'Ingreso confirmado por coincidencia con un movimiento importado.';
    case 'PAYMENT_AUTO_CONFIRMED':
      return 'Ingreso confirmado automáticamente.';
    case 'PAYMENT_REJECTED':
      return `Marcó que no ingresó${m.amount !== undefined ? ` (${money(m.amount)})` : ''}.${withReason(m.reason)}`;
    case 'PAYMENT_DECISION_UNDONE': {
      const previous = m.status ? paymentStateLabel(m.status) : 'la decisión';
      const by = m.verifiedByName || m.verifiedByUsername;
      return `Anuló ${m.status ? `la decisión «${previous}»` : 'la decisión anterior'}${by ? ` tomada por ${by}` : ''}; la consulta volvió a pendiente.${withReason(m.decisionReason || m.rejectionReason)}`;
    }
    case 'PAYMENT_PRINT_OPENED':
      return 'Abrió el ticket en la ventana de impresión (todavía sin confirmar que salió).';
    case 'PAYMENT_PRINTED':
      return m.receiptNumber
        ? `Ticket impreso con el comprobante de conciliación ${m.receiptNumber}.`
        : 'Ticket de la consulta impreso.';
    case 'PAYMENT_CASH_PAID':
      return 'Marcó el pago en caja.';
    case 'PAYMENT_BANK_RECONCILED': {
      const strength = STRENGTH_LABELS[m.matchStrength] ?? '';
      const proof = evidence(m.matchEvidence);
      const pending = Number(m.pendingAfter);
      return `Concilió ${money(m.amount)} con la transferencia del banco${m.bankDocNumber ? ` (doc. ${m.bankDocNumber})` : ''}${m.receiptNumber ? `, comprobante ${m.receiptNumber}` : ''}.${
        strength ? ` Coincidencia ${strength}${proof ? ` (${proof})` : ''}.` : ''
      }${Number.isFinite(pending) ? (pending > 0 ? ` A la consulta le faltan ${money(pending)}.` : ' La consulta quedó cubierta.') : ''}`;
    }
    case 'PAYMENT_BANK_RECONCILIATION_VOIDED':
      return `Anuló la conciliación${m.receiptNumber ? ` ${m.receiptNumber}` : ''} por ${money(m.amount)}.${withReason(m.reason)}`;
    case 'BANK_TRANSFER_CLAIMED':
      return `Tomó ${money(m.amount)}${m.partial ? ` de una transferencia de ${money(m.transferAmount)}` : ''} para ${reference(m.referenceType, m.referenceValue)}; comprobante ${m.receiptNumber}.${
        m.reusedReference ? ' Esa referencia ya tenía otro cobro (pago partido confirmado).' : ''
      }`;
    case 'BANK_TRANSFER_CLAIM_CONFLICT':
      return `Quiso tomar la transferencia para ${reference(m.referenceType, m.referenceValue)} y no pudo: ${CONFLICT_LABELS[m.reason] ?? 'el sistema lo rechazó'}.`;
    case 'BANK_TRANSFER_CLAIM_VOIDED':
      return `Anuló la toma ${m.receiptNumber} de ${m.claimedBy ?? 'otro usuario'} (${money(m.amount)}, ${reference(m.referenceType, m.referenceValue)}).${withReason(m.reason)}`;
    case 'BANK_TRANSFER_RECEIPT_PRINT_OPENED':
      return `Abrió el comprobante ${m.receiptNumber} en la ventana de impresión${m.copy > 1 ? ` (copia ${m.copy})` : ''}, todavía sin confirmar que salió.`;
    case 'BANK_TRANSFER_RECEIPT_PRINTED':
      return `Comprobante ${m.receiptNumber} impreso${m.printCount > 1 ? ` (reimpresión, copia ${m.printCount})` : ''}.`;
    case 'BANK_CLAIM_REVIEWED':
      return `Revisó la conciliación${m.receiptNumber ? ` ${m.receiptNumber}` : ''} y la dio por buena, sin anular nada.`;
    case 'BANK_TRANSFER_REVERSED':
      return `El banco reversó la transferencia${m.activeClaims ? `; tenía ${m.activeClaims} toma(s) activa(s) por ${money(m.allocatedAmount)}` : ''}.`;
    case 'BANK_TRANSFER_BLOCKED':
      return `Quedó bloqueada para revisión${m.reason ? `: ${String(m.reason).replace(/\s*\([0-9a-f-]{36}\)/gi, '')}` : '.'}`;
    case 'BANK_TRANSFER_RELEASED':
      return `Liberó la transferencia bloqueada.${withReason(m.reason)}`;
    case 'USER_CREATED':
      return `Creó el usuario${m.username ? ` ${m.username}` : ''} con rol ${roleLabel(m.role)}.`;
    case 'USER_UPDATED': {
      const fields = Array.isArray(m.fields) ? m.fields.map((f: string) => USER_FIELDS[f] ?? f) : [];
      return fields.length ? `Modificó ${fields.join(', ')}.` : 'Modificó el usuario.';
    }
    case 'USER_DELETED': {
      const who = [m.name, m.role ? roleLabel(m.role) : null].filter(Boolean).join(', ');
      return `Eliminó al usuario${m.username ? ` ${m.username}` : ''}${who ? ` (${who})` : ''}.`;
    }
    case 'INITIAL_ADMIN_PROVISIONED':
      return `Se creó el primer administrador por mantenimiento.${withReason(m.reason)}`;
    case 'ADMIN_PASSWORD_MAINTENANCE_RESET':
      return `Se restableció la clave de un administrador por mantenimiento.${withReason(m.reason)}`;
    default: {
      const state = log.beforeState !== log.afterState && (log.beforeState || log.afterState)
        ? ` Estado: ${paymentStateLabel(log.beforeState)} → ${paymentStateLabel(log.afterState)}.`
        : '';
      const extras = Object.entries(m)
        .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
        .slice(0, 5)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' · ');
      return `${auditActionLabel(log.action)}.${state}${extras ? ` ${extras}.` : ''}`;
    }
  }
};

/** Cambio de estado de la consulta, solo si cambió de verdad. */
export const auditStateChange = (log: Pick<AuditLog, 'beforeState' | 'afterState'>): string | null =>
  log.afterState && log.beforeState !== log.afterState
    ? `${log.beforeState ? paymentStateLabel(log.beforeState) : 'Nueva'} → ${paymentStateLabel(log.afterState)}`
    : null;

/** Sobre qué consulta, transferencia o usuario fue el movimiento. */
export const auditSubject = (log: Partial<AuditLog>): { main: string; detail: string | null } | null => {
  const p = log.payment;
  if (p) {
    const main = [
      p.clientCode ? `Cód. ${p.clientCode}` : null,
      p.paymentRef ? `ref. ${p.paymentRef}` : null,
      Number.isFinite(Number(p.amount)) ? formatAuditMoney(p.amount, p.currency) : null,
    ].filter(Boolean).join(' · ');
    const detail = [
      p.clientName,
      p.collectorName ? `cargada por ${p.collectorName}` : null,
      p.isAtlasAccount !== undefined ? `depósito ${depositBank(p.isAtlasAccount)}` : null,
    ].filter(Boolean).join(' · ');
    return { main: main || 'Consulta', detail: detail || null };
  }
  const t = log.bankTransfer;
  if (t) {
    return {
      main: `Transferencia ${formatAuditMoney(t.amount, t.currency)}`,
      detail: [t.bankDocNumber ? `doc. ${t.bankDocNumber}` : null, t.movementAt ? `entró ${formatDateTime(t.movementAt)}` : null].filter(Boolean).join(' · ') || null,
    };
  }
  if (log.targetUserName) return { main: `Usuario ${log.targetUserName}`, detail: null };
  return null;
};

/** Quién lo hizo: nombre si se conoce, el usuario aparte. */
export const auditActor = (log: Partial<AuditLog>): { name: string; username: string | null } => {
  if (log.userId === 'system' || log.userId === 'system-auto') return { name: 'Sistema', username: null };
  const name = log.actorName || log.actorUsername || log.userId || '—';
  const username = log.actorUsername && log.actorUsername !== name ? log.actorUsername : null;
  return { name, username };
};
