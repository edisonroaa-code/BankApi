const TZ_OFFSET_REGEX = /[zZ]|[+-]\d{2}:\d{2}$|[+-]\d{2}\d{2}$|[+-]\d{2}$/;
const ISO_NO_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
const ISO_SPACE_NO_TZ = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

const normalizeOffset = (raw: string) => {
  const withT = raw.replace(' ', 'T');
  const offsetNoColon = /([+-]\d{2})(\d{2})$/.exec(withT);
  if (offsetNoColon) {
    return `${withT.slice(0, -5)}${offsetNoColon[1]}:${offsetNoColon[2]}`;
  }
  const offsetShort = /([+-]\d{2})$/.exec(withT);
  if (offsetShort) {
    return `${withT}:00`;
  }
  return withT;
};

export const parseDbTimestamp = (value?: string | Date | null): Date | null => {
  if (!value) return null;
  if (value instanceof Date) return value;
  const raw = String(value).trim();
  if (!raw) return null;
  if (TZ_OFFSET_REGEX.test(raw)) return new Date(normalizeOffset(raw));
  if (ISO_NO_TZ.test(raw)) return new Date(`${raw}Z`);
  if (ISO_SPACE_NO_TZ.test(raw)) return new Date(`${raw.replace(' ', 'T')}Z`);
  return new Date(raw);
};
