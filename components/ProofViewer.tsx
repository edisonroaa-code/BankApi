import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Download, ExternalLink, ImageOff, RotateCcw, RotateCw, Search, X, ZoomIn, ZoomOut } from 'lucide-react';
import { api } from '../services/api';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/* Thumbnail with shimmer placeholder while the authorized blob loads */
const ProofThumbnail = ({ src, onNaturalSize }: { src: string; onNaturalSize: (w: number, h: number) => void }) => {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  return (
    <div className="relative w-full max-h-96 flex items-center justify-center">
      {!loaded && !error && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="skeleton w-full h-48 rounded-lg" />
        </div>
      )}
      {error ? (
        <div className="flex flex-col items-center justify-center py-8 text-gray-400">
          <ImageOff className="w-10 h-10 mb-2" />
          <span className="text-xs">No se pudo cargar la imagen</span>
        </div>
      ) : (
        <img
          src={src}
          alt="Comprobante"
          loading="lazy"
          className={`max-h-96 object-contain mx-auto transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
          onLoad={(e) => {
            setLoaded(true);
            const img = e.currentTarget as HTMLImageElement;
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
              onNaturalSize(img.naturalWidth, img.naturalHeight);
            }
          }}
          onError={() => setError(true)}
        />
      )}
    </div>
  );
};

/** `proofUrl` es opcional: el comprobante se pide al servidor por la consulta, con su permiso y auditoría. */
export const ProofViewer = ({ proofUrl, paymentId }: { proofUrl?: string | null; paymentId?: string | null }) => {
  const [resolved, setResolved] = useState('');
  const [proofMime, setProofMime] = useState('');
  const [loadedFor, setLoadedFor] = useState('');
  const [loadErrorFor, setLoadErrorFor] = useState('');
  const proofKey = `${paymentId || ''}|${proofUrl || ''}`;
  const isPdf = proofMime === 'application/pdf';

  useEffect(() => {
    if (!paymentId) return;
    const abort = new AbortController();
    let objectUrl = '';
    setResolved('');
    setProofMime('');
    setLoadErrorFor('');
    api.get<Blob>(`/payments/${encodeURIComponent(paymentId)}/proof`, {
      responseType: 'blob', signal: abort.signal,
    }).then(({ data }) => {
      if (abort.signal.aborted) return;
      objectUrl = URL.createObjectURL(data);
      setProofMime(data.type);
      setResolved(objectUrl);
      setLoadedFor(proofKey);
    }).catch(() => {
      if (!abort.signal.aborted) setLoadErrorFor(proofKey);
    });
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [proofUrl, paymentId, proofKey]);

  const [open, setOpen] = useState(false);
  // `fitScale` is the scale that fits the image inside the modal; `zoom` is a multiplier over that.
  const [fitScale, setFitScale] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [rotate, setRotate] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  const dragging = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const scale = fitScale * zoom;
  const maxZoom = useMemo(() => {
    // Allow good inspection quality even when fitScale is very small.
    const maxAbsoluteScale = 5; // 500% of original size
    const safeFit = Math.max(fitScale, 0.05);
    return clamp(maxAbsoluteScale / safeFit, 1, 120);
  }, [fitScale]);

  useEffect(() => {
    setZoom((z) => clamp(z, 1, maxZoom));
  }, [maxZoom]);

  const reset = () => {
    setZoom(1);
    setRotate(0);
    setOffset({ x: 0, y: 0 });
  };

  const zoomIn = () => setZoom((z) => clamp(Number((z * 1.2).toFixed(3)), 1, maxZoom));
  const zoomOut = () => setZoom((z) => clamp(Number((z / 1.2).toFixed(3)), 1, maxZoom));
  const zoomFit = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };
  const zoom100 = () => {
    const target = 1 / Math.max(fitScale, 0.05);
    setZoom(clamp(Number(target.toFixed(3)), 1, maxZoom));
    setOffset({ x: 0, y: 0 });
  };

  const canPan = useMemo(() => {
    if (!open || isPdf) return false;
    if (!natural || !containerSize.w || !containerSize.h) return false;
    const rotated = ((rotate % 360) + 360) % 360;
    const baseW = rotated === 90 || rotated === 270 ? natural.h : natural.w;
    const baseH = rotated === 90 || rotated === 270 ? natural.w : natural.h;
    const scaledW = baseW * scale;
    const scaledH = baseH * scale;
    return scaledW > containerSize.w + 1 || scaledH > containerSize.h + 1;
  }, [open, isPdf, natural, containerSize.w, containerSize.h, rotate, scale]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!canPan) return;
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    last.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current || !last.current) return;
    const dx = e.clientX - last.current.x;
    const dy = e.clientY - last.current.y;
    last.current = { x: e.clientX, y: e.clientY };
    setOffset((p) => ({ x: p.x + dx, y: p.y + dy }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragging.current = false;
    last.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch { }
  };

  useEffect(() => {
    if (!open || isPdf) return;
    const el = viewerRef.current;
    if (!el) return;

    // React may register wheel listeners as passive; use a native non-passive listener.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => {
        const next = e.deltaY < 0 ? z * 1.12 : z / 1.12;
        return clamp(Number(next.toFixed(3)), 1, maxZoom);
      });
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [open, isPdf, maxZoom]);

  const openInNewTab = () => { if (resolved) window.open(resolved, '_blank', 'noopener,noreferrer'); };

  const download = () => {
    if (!resolved) return;
    const a = document.createElement('a');
    a.href = resolved;
    a.target = '_blank';
    if (!resolved.startsWith('data:')) {
      a.rel = 'noopener noreferrer';
    }
    a.download = 'comprobante';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // Keep container size updated while modal is open
  useEffect(() => {
    if (!open) return;
    const el = containerRef.current;
    if (!el) return;

    const update = () => {
      const rect = el.getBoundingClientRect();
      setContainerSize({ w: rect.width, h: rect.height });
    };
    update();

    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [open]);

  // Compute fit-to-screen scale (100%) based on container and image natural size (and rotation)
  useEffect(() => {
    if (!open || isPdf) return;
    if (!natural || !containerSize.w || !containerSize.h) return;

    const rotated = ((rotate % 360) + 360) % 360;
    const w = rotated === 90 || rotated === 270 ? natural.h : natural.w;
    const h = rotated === 90 || rotated === 270 ? natural.w : natural.h;

    // Leave some padding so the image doesn't touch edges
    const pad = 24;
    const maxW = Math.max(1, containerSize.w - pad);
    const maxH = Math.max(1, containerSize.h - pad);
    const nextFit = clamp(Math.min(maxW / w, maxH / h, 1), 0.05, 1);

    setFitScale(nextFit);
    setOffset({ x: 0, y: 0 });
  }, [open, isPdf, natural, containerSize.w, containerSize.h, rotate]);

  // Clamp panning so the image doesn't disappear completely
  useEffect(() => {
    if (!open || isPdf) return;
    if (!natural || !containerSize.w || !containerSize.h) return;

    const rotated = ((rotate % 360) + 360) % 360;
    const baseW = rotated === 90 || rotated === 270 ? natural.h : natural.w;
    const baseH = rotated === 90 || rotated === 270 ? natural.w : natural.h;
    const scaledW = baseW * scale;
    const scaledH = baseH * scale;

    const maxX = Math.max(0, (scaledW - containerSize.w) / 2);
    const maxY = Math.max(0, (scaledH - containerSize.h) / 2);
    setOffset((p) => ({
      x: clamp(p.x, -maxX, maxX),
      y: clamp(p.y, -maxY, maxY),
    }));
  }, [open, isPdf, natural, containerSize.w, containerSize.h, rotate, scale]);

  if (!paymentId) return null;
  if (loadErrorFor === proofKey) return <div className="rounded border border-red-200 p-4 text-sm text-red-700">No se pudo cargar el comprobante autorizado. Volvé a abrir la consulta.</div>;
  if (!resolved || loadedFor !== proofKey) return <div className="skeleton h-48 w-full rounded-lg" aria-label="Cargando comprobante" />;

  return (
    <>
      <div className="border rounded-lg p-2 bg-gray-50 flex justify-center">
        {isPdf ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="w-full max-w-md bg-white border rounded p-4 text-left hover:bg-gray-50 transition active:scale-[0.98]"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-slate-800">Comprobante (PDF)</div>
                <div className="text-xs text-gray-500 mt-1">Clic para ver en grande</div>
              </div>
              <Search className="w-5 h-5 text-slate-600" />
            </div>
          </button>
        ) : (
          <button type="button" onClick={() => { reset(); setOpen(true); }} className="w-full">
            <ProofThumbnail
              src={resolved}
              onNaturalSize={(w, h) => setNatural({ w, h })}
            />
          </button>
        )}
      </div>

      {open && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-0 sm:p-4">
          <div className="bg-white w-full max-w-5xl rounded-none sm:rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[100dvh] sm:max-h-[90vh]">
            <div className="p-3 border-b bg-gray-50 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm font-semibold text-slate-800">
                Comprobante {natural && !isPdf ? <span className="text-xs text-gray-500 font-normal">({natural.w}×{natural.h})</span> : null}
              </div>

              <div className="flex flex-wrap items-center gap-1 sm:justify-end">
                {!isPdf && (
                  <>
                    <button type="button" onClick={zoomOut} aria-label="Alejar" className="px-2 py-1 text-xs border rounded hover:bg-white flex items-center gap-1">
                      <ZoomOut className="w-4 h-4" /> -
                    </button>
                    <button type="button" onClick={zoomIn} aria-label="Acercar" className="px-2 py-1 text-xs border rounded hover:bg-white flex items-center gap-1">
                      <ZoomIn className="w-4 h-4" /> +
                    </button>
                    <button type="button" onClick={zoomFit} aria-label="Ajustar a pantalla" className="px-2 py-1 text-xs border rounded hover:bg-white">
                      Ajustar
                    </button>
                    <button type="button" onClick={zoom100} aria-label="Tamaño original" className="px-2 py-1 text-xs border rounded hover:bg-white">
                      <span className="hidden sm:inline">Original</span><span className="sm:hidden">100%</span>
                    </button>
                    <button type="button" onClick={() => setRotate((r) => (r - 90) % 360)} aria-label="Rotar a la izquierda" className="px-2 py-1 text-xs border rounded hover:bg-white flex items-center gap-1">
                      <RotateCcw className="w-4 h-4" /><span className="hidden sm:inline">Rotar</span>
                    </button>
                    <button type="button" onClick={() => setRotate((r) => (r + 90) % 360)} aria-label="Rotar a la derecha" className="px-2 py-1 text-xs border rounded hover:bg-white flex items-center gap-1">
                      <RotateCw className="w-4 h-4" /><span className="hidden sm:inline">Rotar</span>
                    </button>
                    <button type="button" onClick={reset} aria-label="Restablecer visor" className="px-2 py-1 text-xs border rounded hover:bg-white">
                      Reset
                    </button>
                  </>
                )}

                <button type="button" onClick={openInNewTab} aria-label="Abrir en otra pestaña" className="px-2 py-1 text-xs border rounded hover:bg-white flex items-center gap-1">
                  <ExternalLink className="w-4 h-4" /><span className="hidden sm:inline">Abrir</span>
                </button>
                <button type="button" onClick={download} aria-label="Descargar comprobante" className="px-2 py-1 text-xs border rounded hover:bg-white flex items-center gap-1">
                  <Download className="w-4 h-4" /><span className="hidden sm:inline">Descargar</span>
                </button>
                <button type="button" onClick={() => setOpen(false)} aria-label="Cerrar comprobante" className="p-2 hover:bg-white rounded">
                  <X className="w-4 h-4 text-slate-700" />
                </button>
              </div>
            </div>

            <div ref={containerRef} className="flex-1 bg-black/5 overflow-hidden">
              {isPdf ? (
                <iframe title="Comprobante PDF" src={resolved} className="w-full h-full" />
              ) : (
                <div
                  ref={viewerRef}
                  className={`w-full h-full flex items-center justify-center select-none ${canPan ? 'cursor-grab active:cursor-grabbing' : ''}`}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                  onPointerLeave={onPointerUp}
                  style={{ touchAction: 'none' }}
                >
                    <img
                      src={resolved}
                      alt="Comprobante"
                      className="max-w-none"
                      style={{
                        transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale}) rotate(${rotate}deg)`,
                        transformOrigin: 'center center',
                      }}
                      onLoad={(e) => {
                        const img = e.currentTarget as HTMLImageElement;
                        const w = img.naturalWidth || 0;
                        const h = img.naturalHeight || 0;
                        if (w > 0 && h > 0) setNatural({ w, h });
                      }}
                      draggable={false}
                    />
                </div>
              )}
            </div>

            {!isPdf && (
              <div className="p-2 border-t bg-gray-50 text-[11px] text-gray-600 flex justify-between">
                <span>Zoom: {Math.round(scale * 100)}%</span>
                <span>Tip: rueda para zoom{canPan ? ', arrastra para mover' : ''}. Esc para cerrar.</span>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};
