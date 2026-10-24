/**
 * Prueba de conexion con Atlas Connect, de SOLO LECTURA, para correr antes de encender el feed:
 * en una PC con las credenciales del laboratorio o en la consola de Render con las de produccion.
 *
 *   npm run atlas:probe            (desarrollo, con ts-node)
 *   npm run atlas:probe:prod       (build compilado, p. ej. en Render)
 *
 * Lee solo variables del proceso (ATLAS_*, BANK_FEED_*), nunca archivos .env. Con
 * ATLAS_PROBE_DAYS=N revisa tambien los N-1 dias anteriores (util si hoy todavia no entro nada). Consulta movimientos
 * del dia, saldo y catalogo de entidades con el mismo cliente y el mismo parser estricto que usa el
 * feed. No muestra claves, tokens, importes, nombres ni documentos: solo si cada paso funciono,
 * cuantos movimientos llegaron y si la respuesta vino firmada. Nunca llama a operaciones que muevan
 * dinero.
 */
import { AtlasApiError, AtlasClient, readAtlasConfig } from './atlas/atlas-client';
import { isCredit, isReversed } from './atlas/atlas-movements';
import { toNormalizedCredit } from './bank-credit';
import { readBankFeedConfigSafe, startOfLocalDay } from './bank-feed.config';
import { BankTransferSource } from './entities/bank-transfer.entity';
import { AtlasFeedSource } from './bank-feed.sources';

export type ProbeStep = { step: string; ok: boolean; detail: string; ms?: number };

const env = (key: string) => process.env[key];

/** Describe un error sin filtrar texto del banco que no vino autenticado. */
const describe = (error: any): string => {
  if (error instanceof AtlasApiError) return `${error.message}${error.isAuthError ? ' (credenciales o permisos)' : ''}`;
  const name = error?.code || error?.name || 'Error';
  return `${name}: ${String(error?.message || error).slice(0, 200)}`;
};

const timed = async <T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; ms: number }> => {
  const started = Date.now();
  try {
    return { value: await fn(), ms: Date.now() - started };
  } catch (error) {
    return { error, ms: Date.now() - started };
  }
};

export const runAtlasProbe = async (now = new Date()): Promise<{ ok: boolean; steps: ProbeStep[] }> => {
  const steps: ProbeStep[] = [];
  const add = (step: ProbeStep) => steps.push(step);

  const feed = readBankFeedConfigSafe(env);
  const account = (env('BANK_FEED_ACCOUNT') || '').trim();
  if (!account) {
    add({ step: 'configuracion', ok: false, detail: 'Falta BANK_FEED_ACCOUNT (numero de la cuenta a vigilar).' });
    return { ok: false, steps };
  }
  const { config, missing } = readAtlasConfig(env);
  if (!config) {
    add({ step: 'configuracion', ok: false, detail: `Faltan variables: ${missing.join(', ')}.` });
    return { ok: false, steps };
  }

  let client: AtlasClient;
  try {
    client = new AtlasClient(config);
  } catch (error) {
    add({ step: 'configuracion', ok: false, detail: describe(error) });
    return { ok: false, steps };
  }
  add({
    step: 'configuracion',
    ok: true,
    detail: `cuenta ***${account.slice(-3)}, base ${new URL(config.baseUrl).host}${new URL(config.baseUrl).pathname}, verificacion de firma ${config.verifyResponse ? 'OBLIGATORIA' : 'APAGADA'}`,
  });

  // 1. Movimientos: lo mismo que pide el feed, con el parser estricto.
  const days = Math.min(30, Math.max(1, Number(env('ATLAS_PROBE_DAYS')) || 1));
  const from = startOfLocalDay(new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000), feed.tzOffsetMinutes);
  const stepName = days === 1 ? 'movimientos de hoy' : `movimientos de los ultimos ${days} dias`;
  const movements = await timed(() =>
    new AtlasFeedSource(client, { ...feed, account }).fetch({ from, to: now, includeReversed: true }),
  );
  if (movements.value) {
    const list = movements.value.movements;
    const credits = list.filter(isCredit);
    // Normalizar cada credito comprueba que la huella se puede calcular con datos reales.
    let normalizeError: string | null = null;
    let withBank = 0;
    for (const m of credits) {
      try {
        if (toNormalizedCredit(m, BankTransferSource.ATLAS).senderBankName) withBank += 1;
      } catch (error) {
        normalizeError = describe(error);
        break;
      }
    }
    add({
      step: stepName,
      ok: !normalizeError,
      ms: movements.ms,
      detail: normalizeError
        ? `llegaron ${list.length} pero uno no se pudo normalizar: ${normalizeError}`
        : `${list.length} movimientos (${credits.length} creditos, ${credits.filter(isReversed).length} reversados, ${withBank} con banco de origen), respuesta ${movements.value.verified ? 'firmada y verificada' : 'SIN verificar'}`,
    });
  } else {
    add({ step: stepName, ok: false, ms: movements.ms, detail: describe(movements.error) });
  }

  // 2. Saldo: solo se informa que se pudo leer y la moneda, nunca el importe.
  const balance = await timed(() => client.consultarSaldo(account));
  add(
    balance.value
      ? { step: 'saldo', ok: true, ms: balance.ms, detail: `leido (${balance.value.balance.moneda}), respuesta ${balance.value.verified ? 'firmada' : 'SIN verificar'}` }
      : { step: 'saldo', ok: false, ms: balance.ms, detail: describe(balance.error) },
  );

  // 3. Catalogo de entidades: opcional (solo sirve para el banco de origen, hoy apagado).
  if (config.datosGeneralesBaseUrl) {
    const entities = await timed(() => client.consultarEntidadesParticipantes());
    add(
      entities.value
        ? { step: 'catalogo de bancos (opcional)', ok: true, ms: entities.ms, detail: `${entities.value.length} entidades` }
        : { step: 'catalogo de bancos (opcional)', ok: true, ms: entities.ms, detail: `no disponible: ${describe(entities.error)}` },
    );
  }

  return { ok: steps.every((s) => s.ok), steps };
};

if (require.main === module) {
  void runAtlasProbe().then(({ ok, steps }) => {
    for (const s of steps) {
      console.log(`${s.ok ? 'OK   ' : 'FALLA'} ${s.step}${s.ms !== undefined ? ` (${s.ms} ms)` : ''}: ${s.detail}`);
    }
    console.log(ok ? '\nConexion con el banco lista para encender el feed.' : '\nLa conexion NO esta lista: revisar los pasos con FALLA.');
    process.exitCode = ok ? 0 : 1;
  });
}
