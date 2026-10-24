/** Missing or non-integral versions fail closed, including JWTs issued before migration. */
export const hasCurrentTokenVersion = (claim: unknown, current: unknown): boolean =>
  typeof claim === 'number' && Number.isSafeInteger(claim) && claim >= 0 &&
  typeof current === 'number' && Number.isSafeInteger(current) && current >= 0 &&
  claim === current;
