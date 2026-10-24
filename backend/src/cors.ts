const normalizeOrigin = (value: string) => value.trim().replace(/\/+$/, '');

/** Origenes permitidos desde `CORS_ORIGINS` (lista separada por comas). */
export const parseAllowedOrigins = (raw: string | undefined = process.env.CORS_ORIGINS): string[] =>
  (raw ?? '').split(',').map(normalizeOrigin).filter(Boolean);

/**
 * En desarrollo sin `CORS_ORIGINS` se mantiene el comportamiento LAN/Electron.
 * Produccion exige una lista explicita. Con la variable definida, solo esos origenes. Las
 * peticiones sin cabecera Origin (curl, mismo origen) no son CORS y se aceptan.
 * Electron cargado desde file:// envia `Origin: null`; agregar `null` a la lista si se usa.
 */
export const isOriginAllowed = (origin: string | undefined, allowed: string[] = parseAllowedOrigins()) => {
  if (!origin) return true;
  if (allowed.length === 0) return process.env.NODE_ENV !== 'production';
  return allowed.includes(normalizeOrigin(origin));
};

// Se evalua en cada peticion: el decorador del gateway se carga antes que los .env locales.
export const corsOrigin = (
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
) => callback(null, isOriginAllowed(origin));
