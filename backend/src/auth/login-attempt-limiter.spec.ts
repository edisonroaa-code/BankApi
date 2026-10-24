import { HttpStatus } from '@nestjs/common';
import { LoginAttemptLimiter } from './login-attempt-limiter';

describe('Límite de intentos de inicio de sesión', () => {
  let now: number;
  let limiter: LoginAttemptLimiter;

  beforeEach(() => {
    now = Date.parse('2026-09-24T12:00:00Z');
    limiter = new LoginAttemptLimiter(() => now);
  });

  it('bloquea el sexto intento de la misma cuenta e IP sin consultar credenciales', () => {
    for (let i = 0; i < 5; i++) {
      limiter.failure(limiter.begin('Cajero', '192.0.2.10'));
    }
    expect(() => limiter.begin('cajero', '192.0.2.10')).toThrow(
      expect.objectContaining({ status: HttpStatus.TOO_MANY_REQUESTS }),
    );
  });

  it('limita la cuenta aunque se cambie de IP', () => {
    for (let i = 0; i < 12; i++) {
      limiter.failure(limiter.begin('cajero', `192.0.2.${i + 1}`));
    }
    expect(() => limiter.begin('cajero', '198.51.100.20')).toThrow(
      expect.objectContaining({ status: HttpStatus.TOO_MANY_REQUESTS }),
    );
  });

  it('limita el IP aunque cambie el nombre de usuario', () => {
    for (let i = 0; i < 60; i++) {
      limiter.failure(limiter.begin(`usuario-${i}`, '192.0.2.10'));
    }
    expect(() => limiter.begin('otra-cuenta', '192.0.2.10')).toThrow(
      expect.objectContaining({ status: HttpStatus.TOO_MANY_REQUESTS }),
    );
  });

  it('desbloquea tras el plazo y limpia al autenticar correctamente', () => {
    for (let i = 0; i < 5; i++) limiter.failure(limiter.begin('cajero', '192.0.2.10'));
    now += 15 * 60 * 1000 + 1;
    limiter.success(limiter.begin('cajero', '192.0.2.10'));
    for (let i = 0; i < 5; i++) limiter.failure(limiter.begin('cajero', '192.0.2.10'));
    expect(() => limiter.begin('cajero', '192.0.2.10')).toThrow(
      expect.objectContaining({ status: HttpStatus.TOO_MANY_REQUESTS }),
    );
  });

  it('reserva cupos antes del trabajo asíncrono para evitar una ráfaga simultánea', () => {
    const pending = Array.from({ length: 5 }, () => limiter.begin('cajero', '192.0.2.10'));
    expect(() => limiter.begin('cajero', '192.0.2.10')).toThrow();
    pending.forEach((reservation) => limiter.release(reservation));
    expect(() => limiter.begin('cajero', '192.0.2.10')).not.toThrow();
  });

  it('falla cerrado cuando se llena la memoria acotada', () => {
    limiter = new LoginAttemptLimiter(() => now, 4);
    limiter.failure(limiter.begin('cajero', '192.0.2.10'));
    expect(() => limiter.begin('otro', '198.51.100.20')).toThrow(
      expect.objectContaining({ status: HttpStatus.TOO_MANY_REQUESTS }),
    );
  });
});
