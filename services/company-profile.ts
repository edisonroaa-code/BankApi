export interface CompanyProfile {
  /** Nombre comercial de la empresa donde se instaló BankApi (aparece en barra superior y tickets de 80mm). */
  companyName: string;
  /** RUC o identificador fiscal opcional para mostrar en cabecera de tickets. */
  companyRuc: string;
  /** Subtítulo descriptivo en la pantalla de acceso. */
  tagline: string;
  /** Nombre visible de la cuenta bancaria conectada por API (ej. "Banco Atlas", "Banco Itaú"). */
  apiBankName: string;
  /** Nombre visible de la cuenta bancaria de verificación manual (ej. "BNF", "Cuenta Manual"). */
  manualBankName: string;
  /** Leyenda al pie del ticket térmico de 80 mm. */
  ticketFooter: string;
}

export const COMPANY_PROFILE_STORAGE_KEY = 'bankapi_company_profile_v1';
export const COMPANY_PROFILE_EVENT = 'bankapi:company-profile-changed';

export const DEFAULT_COMPANY_PROFILE: CompanyProfile = {
  companyName: 'BankApi',
  companyRuc: '',
  tagline: 'Sistema de verificación de cobranzas en Caja y Área de Cobranzas',
  apiBankName: 'Atlas',
  manualBankName: 'BNF',
  ticketFooter: 'NO VÁLIDO COMO FACTURA LEGAL',
};

export const loadCompanyProfile = (): CompanyProfile => {
  if (typeof window === 'undefined') return DEFAULT_COMPANY_PROFILE;
  try {
    const raw = localStorage.getItem(COMPANY_PROFILE_STORAGE_KEY);
    if (!raw) return DEFAULT_COMPANY_PROFILE;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_COMPANY_PROFILE;
    return {
      companyName: typeof parsed.companyName === 'string' && parsed.companyName.trim()
        ? parsed.companyName.trim().slice(0, 60)
        : DEFAULT_COMPANY_PROFILE.companyName,
      companyRuc: typeof parsed.companyRuc === 'string'
        ? parsed.companyRuc.trim().slice(0, 30)
        : DEFAULT_COMPANY_PROFILE.companyRuc,
      tagline: typeof parsed.tagline === 'string' && parsed.tagline.trim()
        ? parsed.tagline.trim().slice(0, 120)
        : DEFAULT_COMPANY_PROFILE.tagline,
      apiBankName: typeof parsed.apiBankName === 'string' && parsed.apiBankName.trim()
        ? parsed.apiBankName.trim().slice(0, 40)
        : DEFAULT_COMPANY_PROFILE.apiBankName,
      manualBankName: typeof parsed.manualBankName === 'string' && parsed.manualBankName.trim()
        ? parsed.manualBankName.trim().slice(0, 40)
        : DEFAULT_COMPANY_PROFILE.manualBankName,
      ticketFooter: typeof parsed.ticketFooter === 'string' && parsed.ticketFooter.trim()
        ? parsed.ticketFooter.trim().slice(0, 80)
        : DEFAULT_COMPANY_PROFILE.ticketFooter,
    };
  } catch {
    return DEFAULT_COMPANY_PROFILE;
  }
};

export const saveCompanyProfile = (next: Partial<CompanyProfile>): CompanyProfile => {
  const current = loadCompanyProfile();
  const merged: CompanyProfile = {
    companyName: (next.companyName ?? current.companyName).trim() || DEFAULT_COMPANY_PROFILE.companyName,
    companyRuc: (next.companyRuc ?? current.companyRuc).trim(),
    tagline: (next.tagline ?? current.tagline).trim() || DEFAULT_COMPANY_PROFILE.tagline,
    apiBankName: (next.apiBankName ?? current.apiBankName).trim() || DEFAULT_COMPANY_PROFILE.apiBankName,
    manualBankName: (next.manualBankName ?? current.manualBankName).trim() || DEFAULT_COMPANY_PROFILE.manualBankName,
    ticketFooter: (next.ticketFooter ?? current.ticketFooter).trim() || DEFAULT_COMPANY_PROFILE.ticketFooter,
  };
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(COMPANY_PROFILE_STORAGE_KEY, JSON.stringify(merged));
      window.dispatchEvent(new CustomEvent(COMPANY_PROFILE_EVENT, { detail: merged }));
    } catch {
      // ignore storage errors
    }
  }
  return merged;
};

export const resetCompanyProfile = (): CompanyProfile => {
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem(COMPANY_PROFILE_STORAGE_KEY);
      window.dispatchEvent(new CustomEvent(COMPANY_PROFILE_EVENT, { detail: DEFAULT_COMPANY_PROFILE }));
    } catch {
      // ignore
    }
  }
  return DEFAULT_COMPANY_PROFILE;
};
