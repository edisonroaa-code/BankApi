import { HttpException, HttpStatus } from '@nestjs/common';
import { createHash } from 'crypto';

const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

type Scope = 'pair' | 'account' | 'address';
type Counter = {
  failures: number;
  inFlight: number;
  expiresAt: number;
  blockedUntil: number;
  limit: number;
};
type ReservationEntry = { key: string; counter: Counter; scope: Scope };
export type LoginReservation = { entries: ReservationEntry[] };

/**
 * Defensa local al proceso. La reserva previa al bcrypt impide que una ráfaga concurrente
 * atraviese el límite. No compartir esta instancia entre procesos/instancias vía memoria.
 */
export class LoginAttemptLimiter {
  private readonly counters = new Map<string, Counter>();
  private lastSweepAt = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {}

  private key(scope: Scope, value: string): string {
    return `${scope}:${createHash('sha256').update(value).digest('hex')}`;
  }

  private denied(): never {
    // No se indica si la cuenta existe ni cuál de los límites se alcanzó.
    throw new HttpException('Demasiados intentos de acceso. Intentá más tarde.', HttpStatus.TOO_MANY_REQUESTS);
  }

  private expired(counter: Counter, now: number): boolean {
    return counter.inFlight === 0 && now >= counter.expiresAt && now >= counter.blockedUntil;
  }

  private sweep(now: number): void {
    if (now - this.lastSweepAt < 60_000 && this.counters.size < this.maxEntries - 3) return;
    for (const [key, counter] of this.counters) {
      if (this.expired(counter, now)) this.counters.delete(key);
    }
    this.lastSweepAt = now;
  }

  begin(username: string, address: string): LoginReservation {
    const now = this.now();
    this.sweep(now);
    const account = username.trim().toLocaleLowerCase('en-US');
    const ip = address || 'unknown';
    const scopes: Array<{ scope: Scope; key: string; limit: number }> = [
      { scope: 'pair', key: this.key('pair', `${account}\0${ip}`), limit: 5 },
      { scope: 'account', key: this.key('account', account), limit: 12 },
      { scope: 'address', key: this.key('address', ip), limit: 60 },
    ];

    const resolved = scopes.map(({ scope, key, limit }) => {
      let counter = this.counters.get(key);
      if (counter && this.expired(counter, now)) {
        this.counters.delete(key);
        counter = undefined;
      }
      return { scope, key, limit, counter };
    });
    if (resolved.some(({ counter }) => counter && (counter.blockedUntil > now || counter.failures + counter.inFlight >= counter.limit))) {
      this.denied();
    }
    if (this.counters.size + resolved.filter(({ counter }) => !counter).length > this.maxEntries) {
      this.denied(); // Sin evicción de límites activos: fallar cerrado.
    }

    const entries = resolved.map(({ scope, key, limit, counter }) => {
      const current = counter ?? { failures: 0, inFlight: 0, expiresAt: now + WINDOW_MS, blockedUntil: 0, limit };
      current.inFlight++;
      if (!counter) this.counters.set(key, current);
      return { scope, key, counter: current };
    });
    return { entries };
  }

  private finish(reservation: LoginReservation, outcome: 'failure' | 'success' | 'release'): void {
    const now = this.now();
    for (const { key, counter, scope } of reservation.entries) {
      if (this.counters.get(key) !== counter) continue;
      counter.inFlight = Math.max(0, counter.inFlight - 1);
      if (outcome === 'failure') {
        counter.failures++;
        if (counter.failures >= counter.limit) counter.blockedUntil = now + LOCK_MS;
      } else if (outcome === 'success' && scope !== 'address') {
        counter.failures = 0;
        counter.blockedUntil = 0;
      }
      if (counter.inFlight === 0 && counter.failures === 0 && counter.blockedUntil === 0) {
        this.counters.delete(key);
      }
    }
  }

  failure(reservation: LoginReservation): void { this.finish(reservation, 'failure'); }
  success(reservation: LoginReservation): void { this.finish(reservation, 'success'); }
  release(reservation: LoginReservation): void { this.finish(reservation, 'release'); }
}
