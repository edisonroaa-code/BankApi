import { io, Socket } from 'socket.io-client';
import { getApiBaseURL } from './api';

export type PaymentsRealtimeEvent = {
  type: string;
  paymentId?: string;
  targetUserId?: string;
  ts: string;
};

const getToken = (): string | null => {
  try {
    const raw = localStorage.getItem('bankapi_session_v1');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.access_token === 'string' ? parsed.access_token : null;
  } catch {
    return null;
  }
};

const getRealtimeServerUrl = (): string => {
  const base = (getApiBaseURL() || '').trim();
  if (base.startsWith('http://') || base.startsWith('https://')) {
    try {
      const u = new URL(base);
      return `${u.protocol}//${u.host}`;
    } catch {
      return base;
    }
  }

  // If API base is relative (e.g. "/api" in dev), keep sockets on the same origin
  // and let Vite proxy `/socket.io` -> backend (3000).
  if (base.startsWith('/')) {
    if (typeof window !== 'undefined' && window.location?.origin?.startsWith('http')) {
      try {
        return window.location.origin;
      } catch {
        // ignore
      }
    }
    return 'http://localhost:3000';
  }

  return base || 'http://localhost:3000';
};

export const createRealtimeSocket = (): Socket => {
  const token = getToken();
  return io(`${getRealtimeServerUrl()}/realtime`, {
    path: '/socket.io',
    // Allow fallback to polling if websockets are blocked by firewall/proxy.
    transports: ['polling', 'websocket'],
    autoConnect: !!token,
    auth: token ? { token } : undefined,
  });
};

/**
 * Marca este socket como "panel de transferencias a la vista". El backend consulta al banco solo
 * mientras haya al menos uno: la app abierta en otra pantalla o en una pestaña oculta no genera
 * consultas. "A la vista" es la pestaña visible **o** la ventana con el foco: Windows y Chrome
 * informan "oculta" una ventana tapada por otra (por ejemplo, el programa de facturación en el
 * escritorio remoto de la caja) y el aviso de vuelta puede no llegar aunque la persona la esté
 * usando. Por eso también se vuelve a avisar con el foco, un clic o una tecla en el panel.
 * Se repite en cada reconexión (las salas no sobreviven a un corte) y `onVisible` permite ponerse
 * al día cuando el panel vuelve a estar a la vista.
 */
export const trackBankPanelDemand = (socket: Socket, onVisible?: () => void): (() => void) => {
  const hasDom = typeof document !== 'undefined' && typeof window !== 'undefined';
  const inView = () => !hasDom || document.visibilityState === 'visible' || document.hasFocus();
  // Lo último que se le avisó al servidor; tras una reconexión se avisa de nuevo igual.
  let announced: boolean | null = null;
  const sync = (force = false) => {
    if (!socket.connected) return;
    const open = inView();
    if (!force && announced === open) return;
    announced = open;
    socket.emit(open ? 'bank-panel:open' : 'bank-panel:close');
  };
  const onConnect = () => sync(true);
  const onChange = () => {
    const wasOpen = announced === true;
    sync();
    if (announced === true && !wasOpen) onVisible?.();
  };
  // Un clic o una tecla prueban que alguien mira, aunque el navegador diga lo contrario.
  const onInteraction = () => {
    if (announced !== true) onChange();
  };
  socket.on('connect', onConnect);
  sync(true);
  if (hasDom) {
    document.addEventListener('visibilitychange', onChange);
    window.addEventListener('focus', onChange);
    window.addEventListener('blur', onChange);
    window.addEventListener('pointerdown', onInteraction, true);
    window.addEventListener('keydown', onInteraction, true);
  }
  return () => {
    socket.off('connect', onConnect);
    if (hasDom) {
      document.removeEventListener('visibilitychange', onChange);
      window.removeEventListener('focus', onChange);
      window.removeEventListener('blur', onChange);
      window.removeEventListener('pointerdown', onInteraction, true);
      window.removeEventListener('keydown', onInteraction, true);
    }
    if (socket.connected) socket.emit('bank-panel:close');
  };
};
