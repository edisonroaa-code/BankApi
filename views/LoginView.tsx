import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, LayoutDashboard, Loader2, Server, Settings, Trash2 } from 'lucide-react';
import { api, canOverrideApiBaseURL, clearApiBaseURL, getApiBaseURL, isElectronApp, isNativeApp, setApiBaseURL } from '../services/api';
import { loadCompanyProfile } from '../services/company-profile';

export const LoginView = ({ onLogin, onOpenStart }: { onLogin: () => void; onOpenStart?: () => void }) => {
  const SAVED_USERS_KEY = 'bankapi_saved_users_v1';
  const LAST_USER_KEY = 'bankapi_last_user_v1';
  const SAVED_PASSWORD_ENABLED_KEY = 'bankapi_saved_password_enabled_v1';
  const company = loadCompanyProfile();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberUser, setRememberUser] = useState(true);
  const [rememberPassword, setRememberPassword] = useState(false);
  const [savedUsers, setSavedUsers] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SAVED_USERS_KEY);
      const list = raw ? JSON.parse(raw) : [];
      if (Array.isArray(list)) setSavedUsers(list.map((x) => String(x)).filter(Boolean));
    } catch {
      // ignore
    }
    try {
      const last = localStorage.getItem(LAST_USER_KEY);
      if (last && last.trim()) setUsername(last.trim());
    } catch {
      // ignore
    }

    try {
      const enabled = localStorage.getItem(SAVED_PASSWORD_ENABLED_KEY);
      setRememberPassword(enabled === '1');
    } catch {
      // ignore
    }

    (async () => {
      try {
        if (!isElectronApp) return;
        if (!(window as any)?.bankapi?.credentials?.get) return;
        const enabled = localStorage.getItem(SAVED_PASSWORD_ENABLED_KEY) === '1';
        if (!enabled) return;
        const res = await (window as any).bankapi.credentials.get();
        if (!res?.ok) return;
        if (res.username) setUsername(String(res.username));
        if (res.password) setPassword(String(res.password));
      } catch {
        // ignore
      }
    })();
  }, []);

  const showServerConfig = canOverrideApiBaseURL;
  const initialServerOpen = (() => {
    if (!showServerConfig) return false;
    const base = getApiBaseURL();
    return !/^https?:\/\//i.test(base.trim());
  })();
  const [serverOpen, setServerOpen] = useState(initialServerOpen);
  const [serverUrl, setServerUrl] = useState(getApiBaseURL());
  const [serverStatus, setServerStatus] = useState<string | null>(null);

  const isAbsoluteHttpUrl = (value: string) => /^https?:\/\//i.test(value.trim());

  const saveServerUrl = () => {
    setServerStatus(null);
    const next = serverUrl.trim();
    if (!isAbsoluteHttpUrl(next)) {
      setServerStatus('Usá una URL absoluta, por ejemplo: https://tu-dominio.com o http://192.168.1.10:48300');
      return;
    }
    setApiBaseURL(next);
    setServerUrl(getApiBaseURL());
    setServerStatus('Servidor guardado.');
  };

  const useServerPreset = (url: string) => {
    setServerStatus(null);
    setServerUrl(url);
    setApiBaseURL(url);
    setServerStatus('Servidor guardado.');
  };

  const restoreDefaultServerUrl = () => {
    clearApiBaseURL();
    setServerUrl(getApiBaseURL());
    setServerStatus('Servidor restaurado al valor por defecto.');
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const { data } = await api.post('/auth/login', { username, password });
      localStorage.setItem('bankapi_session_v1', JSON.stringify(data));
      if (rememberUser) {
        try {
          const u = username.trim();
          if (u) {
            localStorage.setItem(LAST_USER_KEY, u);
            const merged = Array.from(new Set([u, ...savedUsers])).slice(0, 20);
            localStorage.setItem(SAVED_USERS_KEY, JSON.stringify(merged));
            setSavedUsers(merged);
          }
        } catch {
          // ignore
        }
      }
      if (isElectronApp && (window as any)?.bankapi?.credentials) {
        try {
          if (rememberPassword) {
            localStorage.setItem(SAVED_PASSWORD_ENABLED_KEY, '1');
            await (window as any).bankapi.credentials.save({ username: username.trim(), password });
          } else {
            localStorage.setItem(SAVED_PASSWORD_ENABLED_KEY, '0');
            await (window as any).bankapi.credentials.clear();
          }
        } catch {
          // ignore
        }
      }
      onLogin();
    } catch {
      const base = getApiBaseURL();
      if (showServerConfig && !isAbsoluteHttpUrl(base)) {
        setError('Necesitás configurar el servidor (URL) para conectarte al backend.');
        setServerOpen(true);
      } else {
        setError('Credenciales inválidas o error de conexión.');
      }
    } finally {
      setLoading(false);
    }
  };

  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(serverUrl.trim());

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 p-4">
      <div className="bg-white p-8 rounded-lg shadow-lg max-w-md w-full">
        {(showServerConfig || onOpenStart) && (
          <div className="flex justify-end -mt-2 mb-2 gap-3">
            {onOpenStart && isElectronApp && (
              <button
                type="button"
                onClick={onOpenStart}
                className="inline-flex items-center gap-2 text-xs text-slate-500 hover:text-slate-800"
                title="Modo inicio (servidor/diagnóstico)"
              >
                <Server className="w-4 h-4" />
                Modo inicio
              </button>
            )}
            {showServerConfig && (
              <button
                type="button"
                onClick={() => setServerOpen((v) => !v)}
                className="inline-flex items-center gap-2 text-xs text-slate-500 hover:text-slate-800"
                title="Configuración de servidor"
              >
                <Settings className="w-4 h-4" />
                Configuración
              </button>
            )}
          </div>
        )}

        <div className="flex justify-center mb-5">
          <div className="p-2.5 rounded-2xl bg-slate-900 border border-emerald-500/30 shadow-md">
            <img
              src={`${import.meta.env.BASE_URL}logo.png`}
              alt="BankApi"
              className="h-14 w-14 rounded-xl"
            />
          </div>
        </div>

        <h1 className="text-2xl font-bold text-center mb-1 text-slate-900 tracking-tight">BankApi</h1>
        {company.companyName && company.companyName.toLowerCase() !== 'bankapi' && (
          <p className="text-xs font-semibold text-emerald-700 text-center mb-1 uppercase tracking-wider">
            {company.companyName}
          </p>
        )}
        <p className="text-slate-500 text-center mb-6 text-sm">
          {company.tagline || 'Plataforma empresarial de verificación de cobranzas y transferencias bancarias en caja'}
        </p>

        {showServerConfig && (
          serverOpen && (
            <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <div className="text-sm font-semibold text-amber-900">Backend (URL)</div>
              <div className="text-[11px] text-amber-900/80 mt-1">
                Esta dirección queda guardada aunque actualices la aplicación. Ejemplo: <b>http://IP_DEL_SERVIDOR:48300</b>
              </div>
              <div className="mt-2 space-y-2">
                <input
                  type="text"
                  className="w-full p-2 border border-amber-200 rounded-lg bg-white outline-none focus:ring-2 focus:ring-amber-400"
                  placeholder="http://IP_DEL_SERVIDOR:48300"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => useServerPreset('http://localhost:48300')}
                    className="px-3 py-1.5 text-xs rounded border border-amber-300 bg-white hover:bg-amber-100"
                    title="Solo funciona en esta misma PC"
                  >
                    Usar localhost
                  </button>
                  <button
                    type="button"
                    onClick={saveServerUrl}
                    className="px-3 py-1.5 text-xs rounded border border-amber-300 bg-white hover:bg-amber-100"
                  >
                    Guardar
                  </button>
                  <button
                    type="button"
                    onClick={restoreDefaultServerUrl}
                    className="px-3 py-1.5 text-xs rounded border border-amber-300 bg-white hover:bg-amber-100"
                  >
                    Restaurar
                  </button>
                  <button
                    type="button"
                    onClick={() => setServerOpen(false)}
                    className="ml-auto px-3 py-1.5 text-xs rounded border border-amber-300 bg-white hover:bg-amber-100"
                  >
                    Ocultar
                  </button>
                </div>
                {serverStatus && <div className="text-[11px] text-amber-900">{serverStatus}</div>}

                {isElectronApp && isLocalhost && (
                  <div className="text-[11px] text-amber-900/90">
                    Estás usando <b>localhost</b>. En PCs cliente, cambiá a <b>http://IP_DEL_SERVIDOR:48300</b>.
                  </div>
                )}

                <div className="text-[11px] text-amber-900/75">
                  Nota: si estás en otra PC, <b>localhost</b> apunta a esa PC (no al servidor). Usá la IP del servidor.
                </div>
              </div>
            </div>
          )
        )}

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Usuario</label>
            <input
              type="text"
              required
              autoComplete="username"
              list={savedUsers.length ? 'saved-users' : undefined}
              className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            {savedUsers.length > 0 && (
              <datalist id="saved-users">
                {savedUsers.map((u) => (
                  <option key={u} value={u} />
                ))}
              </datalist>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Contraseña</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                className="w-full p-3 pr-12 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded hover:bg-gray-100 text-gray-600"
                title={showPassword ? 'Ocultar contraseña' : 'Ver contraseña'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-4 flex-wrap">
              <label className="inline-flex items-center gap-2 text-sm text-gray-700 select-none">
                <input type="checkbox" checked={rememberUser} onChange={(e) => setRememberUser(e.target.checked)} />
                Guardar usuario
              </label>
              {isElectronApp && (
                <label className="inline-flex items-center gap-2 text-sm text-gray-700 select-none">
                  <input
                    type="checkbox"
                    checked={rememberPassword}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setRememberPassword(checked);
                      try {
                        localStorage.setItem(SAVED_PASSWORD_ENABLED_KEY, checked ? '1' : '0');
                        if (!checked && (window as any)?.bankapi?.credentials?.clear) {
                          (window as any).bankapi.credentials.clear();
                        }
                      } catch {
                        // ignore
                      }
                    }}
                  />
                  Recordar clave
                </label>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                try {
                  localStorage.removeItem(SAVED_USERS_KEY);
                  localStorage.removeItem(LAST_USER_KEY);
                  localStorage.removeItem(SAVED_PASSWORD_ENABLED_KEY);
                  setSavedUsers([]);
                  setUsername('');
                  setPassword('');
                  setRememberPassword(false);
                  if ((window as any)?.bankapi?.credentials?.clear) {
                    (window as any).bankapi.credentials.clear();
                  }
                } catch {
                  // ignore
                }
              }}
              className="inline-flex items-center gap-2 text-xs text-slate-500 hover:text-slate-800"
              title="Borrar usuarios guardados"
            >
              <Trash2 className="w-4 h-4" />
              Borrar guardados
            </button>
          </div>

          {error && <p className="text-red-500 text-sm text-center">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-emerald-600 hover:bg-emerald-700 text-white py-3 rounded-lg font-semibold shadow-sm transition flex items-center justify-center gap-2"
          >
            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <>
                <LayoutDashboard className="w-5 h-5" /> Iniciar sesión
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
};
