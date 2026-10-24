import { HttpStatus, UnauthorizedException } from '@nestjs/common';
import { AuthController, clientAddressForLogin } from './auth.controller';
import { LoginAttemptLimiter } from './login-attempt-limiter';

const request = {
  socket: { remoteAddress: '192.0.2.10' },
  headers: { 'x-forwarded-for': '198.51.100.99', 'cf-connecting-ip': '203.0.113.8' },
};

describe('POST /auth/login', () => {
  it('no acepta X-Forwarded-For manipulable y solo confía en CF-Connecting-IP en Render web', () => {
    expect(clientAddressForLogin(request as any, false)).toBe('192.0.2.10');
    expect(clientAddressForLogin(request as any, true)).toBe('203.0.113.8');
    expect(clientAddressForLogin({ ...request, headers: { 'cf-connecting-ip': 'falso' } } as any, true))
      .toBe('192.0.2.10');
  });

  it('rechaza el sexto intento antes de volver a consultar la base', async () => {
    const auth = {
      validateUser: jest.fn().mockResolvedValue(null),
      login: jest.fn(),
    };
    const controller = new (AuthController as any)(auth, new LoginAttemptLimiter());
    for (let i = 0; i < 5; i++) {
      await expect(controller.login({ username: 'cajero', password: 'incorrecta' }, request)).rejects.toBeInstanceOf(UnauthorizedException);
    }
    await expect(controller.login({ username: 'cajero', password: 'incorrecta' }, request))
      .rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    expect(auth.validateUser).toHaveBeenCalledTimes(5);
    expect(auth.login).not.toHaveBeenCalled();
  });

  it('permite un ingreso válido y no conserva el bloqueo anterior de la pareja cuenta-IP', async () => {
    const user = { id: 'u1', username: 'cajero' };
    const auth = {
      validateUser: jest.fn().mockResolvedValue(user),
      login: jest.fn().mockResolvedValue({ access_token: 'test' }),
    };
    const controller = new (AuthController as any)(auth, new LoginAttemptLimiter());
    await expect(controller.login({ username: 'cajero', password: 'correcta' }, request))
      .resolves.toEqual({ access_token: 'test' });
    expect(auth.validateUser).toHaveBeenCalledTimes(1);
    expect(auth.login).toHaveBeenCalledWith(user);
  });

  it('no deja repetir intentos sin límite si falla la validación interna', async () => {
    const auth = {
      validateUser: jest.fn().mockRejectedValue(new Error('base no disponible')),
      login: jest.fn(),
    };
    const controller = new (AuthController as any)(auth, new LoginAttemptLimiter());
    for (let i = 0; i < 5; i++) {
      await expect(controller.login({ username: 'cajero', password: 'cualquiera' }, request))
        .rejects.toThrow('base no disponible');
    }
    await expect(controller.login({ username: 'cajero', password: 'cualquiera' }, request))
      .rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    expect(auth.validateUser).toHaveBeenCalledTimes(5);
  });
});
