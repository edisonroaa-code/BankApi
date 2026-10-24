/**
 * Rutas que el fallback de la SPA (index.html) no debe atender. Sintaxis de path-to-regexp v8
 * (Express 5): la forma antigua `'/api/(.*)'` lanza error y convertia cualquier ruta
 * desconocida en un 500 cuando el backend sirve el frontend (modo LAN/Electron).
 */
export const SPA_EXCLUDED_ROUTES = ['/api/*path', '/uploads{/*path}', '/health{/*path}', '/realtime{/*path}'];
