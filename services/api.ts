import axios from 'axios';
import { isApiBaseOverrideAllowed } from './api-base-policy';

// In dev, Vite proxies `/api` -> backend (see `vite.config.ts`).
// This keeps the browser always on :5173 and avoids hardcoding backend ports in the frontend.
const API_URL = (import.meta as any).env?.VITE_API_URL || '/api';
const API_URL_STORAGE_KEY = 'bankapi_api_base_url_v1';

export const isNativeApp = (() => {
    // La versión móvil/Capacitor se dejó para una etapa posterior.
    // Mantener este flag en `false` evita dependencias implícitas en `window.Capacitor`.
    return false;
})();

export const isElectronApp = (() => {
    try {
        const target = (import.meta as any).env?.VITE_APP_TARGET;
        if (target === 'electron') return true;
        if (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string') {
            return navigator.userAgent.toLowerCase().includes('electron');
        }
        return false;
    } catch {
        return false;
    }
})();

export const canOverrideApiBaseURL = isApiBaseOverrideAllowed(
    !!(import.meta as any).env?.PROD,
    isElectronApp,
    isNativeApp,
);

const normalizeBaseUrl = (value: string) => value.trim().replace(/\/+$/, '');

const getInitialBaseUrl = () => {
    const envUrl = normalizeBaseUrl(API_URL);
    // Un valor viejo o manipulado en localStorage no puede redirigir el JWT de la PWA cloud.
    if (!canOverrideApiBaseURL) return envUrl;

    // In dev, prefer Vite's proxy-friendly relative URL (`/api`) and ignore any stored value,
    // otherwise CORS + stale settings can break local development.
    if ((import.meta as any).env?.DEV) return envUrl;

    if (typeof window !== 'undefined') {
        const stored = localStorage.getItem(API_URL_STORAGE_KEY);
        if (stored && stored.trim()) {
            return normalizeBaseUrl(stored);
        }
    }

    return envUrl;
};

export const api = axios.create({
    baseURL: getInitialBaseUrl(),
    // Evita que una ruta absoluta futura desvíe el Authorization a otro origen en cloud.
    allowAbsoluteUrls: canOverrideApiBaseURL,
});

export const getApiBaseURL = () => (api.defaults.baseURL || '').toString();

const persistNativeBaseUrl = async (serverUrl: string) => {
    try {
        await window.bankapi?.connection?.save({ serverUrl });
    } catch {
        // The browser build has no native persistence.
    }
};

export const initializeApiBaseURL = async () => {
    if (!isElectronApp || !window.bankapi?.connection?.get) return getApiBaseURL();

    try {
        const native = await window.bankapi.connection.get();
        if (native?.ok && native.serverUrl) {
            const normalized = normalizeBaseUrl(native.serverUrl);
            api.defaults.baseURL = normalized;
            localStorage.setItem(API_URL_STORAGE_KEY, normalized);
            return normalized;
        }

        const current = getApiBaseURL();
        if (/^https?:\/\//i.test(current)) {
            await persistNativeBaseUrl(current);
        }
        return current;
    } catch {
        return getApiBaseURL();
    }
};

export const setApiBaseURL = (next: string) => {
    if (!canOverrideApiBaseURL) return;
    const normalized = normalizeBaseUrl(next);
    api.defaults.baseURL = normalized;
    if (typeof window !== 'undefined') {
        localStorage.setItem(API_URL_STORAGE_KEY, normalized);
    }
    void persistNativeBaseUrl(normalized);
};

export const clearApiBaseURL = () => {
    api.defaults.baseURL = normalizeBaseUrl(API_URL);
    if (typeof window !== 'undefined') {
        localStorage.removeItem(API_URL_STORAGE_KEY);
    }
    void window.bankapi?.connection?.clear?.();
};

// Add a request interceptor to include the JWT token
api.interceptors.request.use(
    (config) => {
        const user = localStorage.getItem('bankapi_session_v1'); // Session key for BankApi auth
        if (user) {
            try {
                const parsed = JSON.parse(user);
                if (parsed.access_token) {
                    config.headers.Authorization = `Bearer ${parsed.access_token}`;
                }
            } catch (e) {
                // invalid json
            }
        }
        return config;
    },
    (error) => {
        return Promise.reject(error);
    }
);

api.interceptors.response.use(
    (response) => response,
    (error) => {
        const status = error?.response?.status;
        const hasSession = !!localStorage.getItem('bankapi_session_v1');
        if (status === 401 && hasSession) {
            localStorage.removeItem('bankapi_session_v1');
            window.dispatchEvent(new CustomEvent('auth:session-expired'));
        }
        return Promise.reject(error);
    }
);
