export const DB_READINESS_PATH = '/health/db';

export type HealthState =
  | { status: 'unknown' }
  | {
      status: 'ok';
      db: 'ok' | 'down';
      uptimeSec: number;
      responseMs: number;
      time: string;
      error?: string;
    }
  | { status: 'down'; error?: string };

type DbReadinessPayload = {
  status?: unknown;
  db?: unknown;
  uptimeSec?: unknown;
  responseMs?: unknown;
  time?: unknown;
  error?: unknown;
};

const asFiniteNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const isDbReadinessPayload = (payload: unknown): payload is DbReadinessPayload => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const candidate = payload as DbReadinessPayload;
  return (
    (candidate.status === 'ok' || candidate.status === 'degraded') &&
    (candidate.db === 'ok' || candidate.db === 'down')
  );
};

export const parseDbReadinessPayload = (payload: unknown): HealthState => {
  if (!isDbReadinessPayload(payload)) {
    return { status: 'down', error: 'Respuesta invalida del backend' };
  }

  return {
    status: 'ok',
    db: payload.db === 'ok' ? 'ok' : 'down',
    uptimeSec: asFiniteNumber(payload.uptimeSec),
    responseMs: asFiniteNumber(payload.responseMs),
    time: typeof payload.time === 'string' ? payload.time : new Date().toISOString(),
    ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
  };
};

export const ignoreFailure = async <T>(promise: Promise<T>): Promise<T | null> => {
  try {
    return await promise;
  } catch {
    return null;
  }
};

export const parseDbReadinessError = (error: unknown): HealthState => {
  const candidate = error as {
    message?: unknown;
    response?: { data?: DbReadinessPayload };
  };
  const responsePayload = candidate?.response?.data;

  if (isDbReadinessPayload(responsePayload) && responsePayload.db === 'down') {
    return parseDbReadinessPayload(responsePayload);
  }

  return {
    status: 'down',
    error: typeof candidate?.message === 'string' ? candidate.message : 'No se pudo conectar al backend',
  };
};
