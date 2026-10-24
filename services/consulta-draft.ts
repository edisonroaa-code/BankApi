/**
 * Borrador de la consulta que el cobrador está cargando.
 *
 * El formulario vive en la memoria de la pestaña: si la página se recarga entera, se pierde. En el
 * celular eso pasa sin que el cobrador lo pida: el sistema cierra la página al ir a la cámara, a la
 * galería o a la app del banco, el navegador recarga al tirar hacia abajo, una actualización
 * aceptada o una sesión vencida. Por eso cada cambio se guarda en el propio dispositivo, por
 * usuario: los datos en localStorage y el comprobante en IndexedDB. Nada de esto va al servidor;
 * se borra al enviar la consulta o al descartarlo.
 */

export type ConsultaDraftFields = {
  amount: string;
  client: string;
  clientCode: string;
  refNum: string;
  sourceBank: string;
  isAtlasAccount: boolean | null;
};

export const EMPTY_CONSULTA_DRAFT: ConsultaDraftFields = {
  amount: '',
  client: '',
  clientCode: '',
  refNum: '',
  sourceBank: '',
  isAtlasAccount: null,
};

/** Un borrador de ayer todavía sirve (el comprobante sigue sin enviar); uno de hace días ya no. */
export const CONSULTA_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const KEY_PREFIX = 'tc_consulta_draft_v1:';
const MAX_TEXT = 200;
const DB_NAME = 'tc-borradores';
const DB_STORE = 'comprobantes';

export const consultaDraftKey = (userId: string) => `${KEY_PREFIX}${userId}`;

export const isConsultaDraftEmpty = (fields: ConsultaDraftFields) =>
  !fields.amount.trim() &&
  !fields.client.trim() &&
  !fields.clientCode.trim() &&
  !fields.refNum.trim() &&
  !fields.sourceBank.trim() &&
  fields.isAtlasAccount === null;

export const serializeConsultaDraft = (fields: ConsultaDraftFields, now = Date.now()) =>
  JSON.stringify({ v: 1, savedAt: now, fields });

/** Lee un borrador guardado; uno vencido, vacío o con otra forma se ignora. */
export const parseConsultaDraft = (raw: string | null, now = Date.now()): ConsultaDraftFields | null => {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (data?.v !== 1 || typeof data.savedAt !== 'number') return null;
    if (now - data.savedAt > CONSULTA_DRAFT_MAX_AGE_MS || data.savedAt - now > 60_000) return null;
    const saved = data.fields ?? {};
    const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, MAX_TEXT) : '');
    const fields: ConsultaDraftFields = {
      amount: text(saved.amount),
      client: text(saved.client),
      clientCode: text(saved.clientCode),
      refNum: text(saved.refNum),
      sourceBank: text(saved.sourceBank),
      isAtlasAccount: typeof saved.isAtlasAccount === 'boolean' ? saved.isAtlasAccount : null,
    };
    return isConsultaDraftEmpty(fields) ? null : fields;
  } catch {
    return null;
  }
};

// El almacenamiento puede no existir o fallar (modo privado, cuota llena, datos bloqueados):
// el formulario sigue funcionando igual, solo que sin borrador.
const localStore = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export const loadConsultaDraftFields = (userId: string): ConsultaDraftFields | null => {
  const store = localStore();
  if (!store || !userId) return null;
  try {
    const raw = store.getItem(consultaDraftKey(userId));
    const fields = parseConsultaDraft(raw);
    if (raw && !fields) store.removeItem(consultaDraftKey(userId));
    return fields;
  } catch {
    return null;
  }
};

export const saveConsultaDraftFields = (userId: string, fields: ConsultaDraftFields) => {
  const store = localStore();
  if (!store || !userId) return;
  try {
    if (isConsultaDraftEmpty(fields)) store.removeItem(consultaDraftKey(userId));
    else store.setItem(consultaDraftKey(userId), serializeConsultaDraft(fields));
  } catch {
    // Sin lugar o bloqueado: no frena la carga.
  }
};

const openDraftDb = () =>
  new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

const withDraftStore = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) => {
  const db = await openDraftDb();
  if (!db) return undefined;
  return new Promise<T | undefined>((resolve) => {
    try {
      const tx = db.transaction(DB_STORE, mode);
      const request = run(tx.objectStore(DB_STORE));
      tx.oncomplete = () => {
        db.close();
        resolve(request.result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        resolve(undefined);
      };
    } catch {
      db.close();
      resolve(undefined);
    }
  });
};

type SavedProof = { blob: Blob; name: string; type: string; savedAt: number };

// Cambiar el archivo, limpiar y enviar pueden ocurrir antes de que IndexedDB abra.
// La última acción del usuario debe ganar, no la última apertura de la base que termine.
const pendingProofWrites = new Map<string, Promise<void>>();

/** Guarda el comprobante elegido (o lo borra con `null`). */
export const saveConsultaDraftFile = async (userId: string, file: File | null) => {
  if (!userId) return;
  const write = (pendingProofWrites.get(userId) ?? Promise.resolve()).then(async () => {
    await withDraftStore('readwrite', (store) =>
      file
        ? store.put({ blob: file, name: file.name, type: file.type, savedAt: Date.now() } satisfies SavedProof, userId)
        : store.delete(userId),
    );
  });
  pendingProofWrites.set(userId, write);
  try {
    await write;
  } finally {
    if (pendingProofWrites.get(userId) === write) pendingProofWrites.delete(userId);
  }
};

export const loadConsultaDraftFile = async (userId: string): Promise<File | null> => {
  if (!userId) return null;
  await pendingProofWrites.get(userId);
  const saved = (await withDraftStore('readonly', (store) => store.get(userId))) as SavedProof | undefined;
  if (!saved || !(saved.blob instanceof Blob) || typeof saved.savedAt !== 'number') return null;
  if (Date.now() - saved.savedAt > CONSULTA_DRAFT_MAX_AGE_MS) {
    void saveConsultaDraftFile(userId, null);
    return null;
  }
  return new File([saved.blob], saved.name || 'comprobante', { type: saved.type || saved.blob.type });
};

export const clearConsultaDraft = (userId: string) => {
  saveConsultaDraftFields(userId, EMPTY_CONSULTA_DRAFT);
  void saveConsultaDraftFile(userId, null);
};
