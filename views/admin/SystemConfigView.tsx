import React, { useCallback, useEffect, useState } from 'react';
import { Building2, CheckCircle2, KeyRound, Loader2, Play, RefreshCw, RotateCcw, Server, ShieldCheck, AlertTriangle } from 'lucide-react';
import { BankBalance, BankFeedStatus } from '../../types';
import { apiErrorMessage, fetchBankBalance, fetchBankFeedStatus, requestBankRefresh, resumeBankFeed } from '../../services/bankTransfers';
import { CompanyProfile, DEFAULT_COMPANY_PROFILE, loadCompanyProfile, resetCompanyProfile, saveCompanyProfile } from '../../services/company-profile';
import { formatMoney } from '../../components/bank/bankUi';

export const SystemConfigView = ({
  showToast,
}: {
  showToast: (t: 'success' | 'error' | 'info', m: string) => void;
}) => {
  const [profile, setProfile] = useState<CompanyProfile>(() => loadCompanyProfile());
  const [feed, setFeed] = useState<BankFeedStatus | null>(null);
  const [loadingFeed, setLoadingFeed] = useState(true);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<{
    ok: boolean;
    message: string;
    balance?: BankBalance | null;
    checkedAt: string;
  } | null>(null);

  const loadStatus = useCallback(async () => {
    setLoadingFeed(true);
    try {
      const status = await fetchBankFeedStatus();
      setFeed(status);
    } catch (e) {
      showToast('error', apiErrorMessage(e, 'No se pudo consultar el estado del conector bancario.'));
    } finally {
      setLoadingFeed(false);
    }
  }, [showToast]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleSaveProfile = (e: React.FormEvent) => {
    e.preventDefault();
    const saved = saveCompanyProfile(profile);
    setProfile(saved);
    showToast('success', 'Configuración de la empresa guardada. Los tickets y encabezados ya usan los nuevos datos.');
  };

  const handleResetProfile = () => {
    const restored = resetCompanyProfile();
    setProfile(restored);
    showToast('info', 'Valores por defecto de BankApi restaurados.');
  };

  const runBankProbe = async () => {
    setProbing(true);
    setProbeResult(null);
    try {
      const refreshRes = await requestBankRefresh();
      setFeed(refreshRes.status);
      let balanceData: BankBalance | null = null;
      try {
        balanceData = await fetchBankBalance();
      } catch {
        balanceData = null;
      }
      const st = refreshRes.status;
      const isOk = st.state === 'EN_VIVO' || st.state === 'EN_ESPERA' || !!balanceData;
      setProbeResult({
        ok: isOk,
        message: isOk
          ? `Conexión operativa (${st.mode.toUpperCase()}). Estado: ${st.state}.`
          : st.lastError || `El conector respondió en estado ${st.state}.`,
        balance: balanceData,
        checkedAt: new Date().toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      });
      showToast(isOk ? 'success' : 'info', isOk ? 'Diagnóstico bancario completado con éxito.' : 'El conector requiere atención.');
    } catch (e) {
      const msg = apiErrorMessage(e, 'La prueba de conexión bancaria falló.');
      setProbeResult({
        ok: false,
        message: msg,
        balance: null,
        checkedAt: new Date().toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      });
      showToast('error', msg);
    } finally {
      setProbing(false);
    }
  };

  const handleResumeFeed = async () => {
    try {
      const st = await resumeBankFeed();
      setFeed(st);
      showToast('success', 'Conector bancario reanudado.');
    } catch (e) {
      showToast('error', apiErrorMessage(e, 'No se pudo reanudar el conector bancario.'));
    }
  };

  return (
    <div className="space-y-6">
      {/* 1. Perfil Comercial de la Empresa Instalada */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-100 bg-slate-50/70 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-emerald-100 text-emerald-700">
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-slate-800 text-base">Identidad de la Empresa y Tickets 80 mm</h3>
              <p className="text-xs text-slate-500">
                Configurá el nombre comercial que verán los operadores y que saldrá impreso en los comprobantes de Caja y Cobranzas.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleResetProfile}
            className="inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Restaurar {DEFAULT_COMPANY_PROFILE.companyName}
          </button>
        </div>

        <form onSubmit={handleSaveProfile} className="p-5 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                Nombre de la Empresa (Cabecera y Tickets)
              </label>
              <input
                type="text"
                required
                maxLength={60}
                value={profile.companyName}
                onChange={(e) => setProfile({ ...profile, companyName: e.target.value })}
                placeholder="Ej. Comercial San José S.A. o BankApi"
                className="w-full p-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                RUC / Identificador Fiscal (Opcional en Ticket)
              </label>
              <input
                type="text"
                maxLength={30}
                value={profile.companyRuc}
                onChange={(e) => setProfile({ ...profile, companyRuc: e.target.value })}
                placeholder="Ej. 80012345-6"
                className="w-full p-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                Etiqueta Cuenta con API Bancaria
              </label>
              <input
                type="text"
                required
                maxLength={40}
                value={profile.apiBankName}
                onChange={(e) => setProfile({ ...profile, apiBankName: e.target.value })}
                placeholder="Ej. Atlas"
                className="w-full p-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 outline-none"
              />
              <span className="text-[11px] text-slate-500 mt-1 block">
                Cuenta verificada automáticamente contra movimientos de la API bancaria.
              </span>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                Etiqueta Cuenta de Verificación Manual
              </label>
              <input
                type="text"
                required
                maxLength={40}
                value={profile.manualBankName}
                onChange={(e) => setProfile({ ...profile, manualBankName: e.target.value })}
                placeholder="Ej. BNF o Cuenta Manual"
                className="w-full p-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 outline-none"
              />
              <span className="text-[11px] text-slate-500 mt-1 block">
                Cuenta secundaria aprobada manualmente por Administración.
              </span>
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                Leyenda al Pie del Ticket Térmico (80 mm)
              </label>
              <input
                type="text"
                required
                maxLength={80}
                value={profile.ticketFooter}
                onChange={(e) => setProfile({ ...profile, ticketFooter: e.target.value })}
                placeholder="NO VÁLIDO COMO FACTURA LEGAL"
                className="w-full p-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 outline-none"
              />
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              className="bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2.5 rounded-lg text-sm font-semibold transition flex items-center gap-2 shadow-sm"
            >
              <CheckCircle2 className="w-4 h-4" /> Guardar Configuración de Empresa
            </button>
          </div>
        </form>
      </div>

      {/* 2. Estado y Diagnóstico de la API Bancaria */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-100 bg-slate-50/70 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-slate-900 text-emerald-400">
              <Server className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-slate-800 text-base">Conector de API Bancaria (Estado y Homologación)</h3>
              <p className="text-xs text-slate-500">
                Verificación en vivo de lectura de movimientos, firma RS256 y disponibilidad del feed bancario.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadStatus()}
              disabled={loadingFeed}
              className="inline-flex items-center gap-1.5 text-xs text-slate-700 hover:text-slate-900 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingFeed ? 'animate-spin' : ''}`} /> Estado
            </button>
            <button
              type="button"
              onClick={() => void runBankProbe()}
              disabled={probing}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 px-3.5 py-2 rounded-lg transition disabled:opacity-50"
            >
              {probing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5 text-emerald-400" />}
              Probar Conexión con el Banco
            </button>
          </div>
        </div>

        <div className="p-5 space-y-4">
          {loadingFeed && !feed ? (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Consultando estado del conector bancario...
            </div>
          ) : feed ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                <div className="text-[11px] font-bold uppercase text-slate-500">Modo Activo</div>
                <div className="text-base font-bold text-slate-800 mt-0.5 uppercase">{feed.mode}</div>
              </div>
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                <div className="text-[11px] font-bold uppercase text-slate-500">Estado del Feed</div>
                <div className="text-base font-bold text-emerald-700 mt-0.5">{feed.state}</div>
              </div>
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                <div className="text-[11px] font-bold uppercase text-slate-500">Horario Operativo</div>
                <div className="text-base font-bold text-slate-800 mt-0.5">{feed.hours}</div>
              </div>
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                <div className="text-[11px] font-bold uppercase text-slate-500">Intervalo Sondeo</div>
                <div className="text-base font-bold text-slate-800 mt-0.5">Cada {feed.intervalSeconds} s</div>
              </div>
            </div>
          ) : null}

          {feed?.lastError && (
            <div className="p-3.5 rounded-lg bg-amber-50 border border-amber-200 flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5 text-xs text-amber-900">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold">Observación del conector bancario</div>
                  <div className="mt-0.5">{feed.lastError}</div>
                </div>
              </div>
              {feed.state === 'DETENIDO' && (
                <button
                  type="button"
                  onClick={() => void handleResumeFeed()}
                  className="shrink-0 px-3 py-1.5 rounded bg-amber-700 text-white text-xs font-semibold hover:bg-amber-800"
                >
                  Reanudar
                </button>
              )}
            </div>
          )}

          {probeResult && (
            <div
              className={`p-4 rounded-lg border text-sm ${
                probeResult.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-950' : 'bg-red-50 border-red-200 text-red-950'
              }`}
            >
              <div className="flex items-center justify-between gap-2 font-bold">
                <span>Resultado del Diagnóstico ({probeResult.checkedAt})</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-white/80 border">
                  {probeResult.ok ? 'CONEXIÓN OK' : 'REQUIERE REVISIÓN'}
                </span>
              </div>
              <p className="mt-1 text-xs">{probeResult.message}</p>
              {probeResult.balance && (
                <div className="mt-2 pt-2 border-t border-emerald-200/70 text-xs flex flex-wrap gap-4">
                  <span>
                    <strong>Cuenta:</strong> {probeResult.balance.balance.nroCuenta}
                  </span>
                  <span>
                    <strong>Producto:</strong> {probeResult.balance.balance.producto.descripcion}
                  </span>
                  <span>
                    <strong>Saldo Disponible:</strong>{' '}
                    {formatMoney(probeResult.balance.balance.saldoDisponible, probeResult.balance.balance.moneda)}
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="p-4 rounded-lg bg-slate-900 text-slate-200 text-xs space-y-2">
            <div className="flex items-center gap-2 font-bold text-emerald-400">
              <KeyRound className="w-4 h-4" /> Guía de Puesta en Marcha para Nueva Empresa (Variables del Servidor)
            </div>
            <p className="text-slate-300 leading-relaxed">
              Al instalar <strong>BankApi</strong> en un nuevo cliente, configurá en el servidor (<code>backend/.env</code> o panel Cloud) las credenciales provistas por el banco:
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 font-mono text-[11px] bg-slate-950/80 p-3 rounded border border-slate-800 text-emerald-300">
              <div>BANK_FEED_MODE=atlas</div>
              <div>BANK_FEED_ACCOUNT=NUMERO_DE_CUENTA</div>
              <div>BANK_FEED_HOURS=07:00-20:00</div>
              <div>BANK_FEED_INTERVAL_SECONDS=5</div>
              <div>ATLAS_API_KEY=***</div>
              <div>ATLAS_ACCOUNT_AUTH_TOKEN=***</div>
              <div>ATLAS_JWT_ISS=ID_EMPRESA_BANCO</div>
              <div>ATLAS_JWT_SUB=ID_EMPRESA_BANCO</div>
              <div className="md:col-span-2">ATLAS_PRIVATE_KEY_PATH=/ruta/segura/clave_rsa_4096.pem</div>
            </div>
            <p className="text-slate-400 text-[11px] flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              Por seguridad bancaria, las llaves privadas RSA de 4096 bits y los tokens del banco residen únicamente en el servidor y nunca se exponen al navegador.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
