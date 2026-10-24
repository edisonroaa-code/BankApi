import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

const PWA_UPDATE_READY_EVENT = 'pwa:update-ready';
let waitingPwaWorker: ServiceWorker | null = null;

function registerPwaUpdates() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

  void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
    scope: import.meta.env.BASE_URL,
  }).then((registration) => {
    const offerWaitingUpdate = () => {
      if (!navigator.serviceWorker.controller || !registration.waiting) return;
      waitingPwaWorker = registration.waiting;
      window.dispatchEvent(new Event(PWA_UPDATE_READY_EVENT));
    };

    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'installed') offerWaitingUpdate();
      });
    });

    offerWaitingUpdate();
    window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void registration.update().catch((error) => console.warn('No se pudo comprobar la actualización PWA', error));
      }
    }, 60 * 60 * 1000);
  }).catch((error) => console.warn('No se pudo registrar la PWA', error));
}

function activateWaitingPwaUpdate(worker: ServiceWorker | null): boolean {
  if (!worker || !window.confirm('La actualización recargará esta pestaña y puede descartar datos o archivos que aún no enviaste. Terminá tu trabajo antes de continuar. ¿Actualizar ahora?')) {
    return false;
  }

  if (worker.state === 'activated' || worker.state === 'redundant') {
    // Otra pestaña ya activó la versión: esta puede recargarse cuando su usuario lo acepte.
    window.location.reload();
    return true;
  }

  // Solo esta pestaña aceptó la recarga. Las demás conservan sus formularios abiertos.
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
  worker.postMessage({ type: 'SKIP_WAITING' });
  return true;
}

function PwaUpdateNotice() {
  const [worker, setWorker] = React.useState<ServiceWorker | null>(waitingPwaWorker);
  const [dismissed, setDismissed] = React.useState(false);
  const [applying, setApplying] = React.useState(false);

  React.useEffect(() => {
    const onUpdateReady = () => {
      setWorker(waitingPwaWorker);
      setDismissed(false);
    };
    window.addEventListener(PWA_UPDATE_READY_EVENT, onUpdateReady);
    return () => window.removeEventListener(PWA_UPDATE_READY_EVENT, onUpdateReady);
  }, []);

  if (!worker) return null;
  if (dismissed) {
    return <button type="button" onClick={() => setDismissed(false)} className="no-print fixed bottom-4 right-4 z-50 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-lg">Nueva versión disponible</button>;
  }

  return (
    <aside role="status" aria-live="polite" className="no-print fixed bottom-4 left-4 right-4 z-50 rounded-lg border border-slate-200 bg-white p-4 text-slate-800 shadow-xl sm:left-auto sm:max-w-sm">
      <p className="font-semibold">Nueva versión disponible</p>
      <p className="mt-1 text-sm text-slate-600">Podés actualizar cuando termines de cargar tus datos. No se recargará automáticamente.</p>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={() => setDismissed(true)} disabled={applying} className="rounded-md px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50">Más tarde</button>
        <button type="button" onClick={() => { if (activateWaitingPwaUpdate(worker)) setApplying(true); }} disabled={applying} className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50">{applying ? 'Actualizando…' : 'Actualizar ahora'}</button>
      </div>
    </aside>
  );
}

registerPwaUpdates();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
    <PwaUpdateNotice />
  </React.StrictMode>
);
