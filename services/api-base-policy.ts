/** Cloud PWA uses its build-time API origin; only development/native clients may switch servers. */
export const isApiBaseOverrideAllowed = (isProduction: boolean, isElectron: boolean, isNative: boolean) =>
    !isProduction || isElectron || isNative;
