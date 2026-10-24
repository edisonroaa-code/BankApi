import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

const ACCESS_REVOKED = 'access-revoked';

/**
 * Avisa en proceso que un usuario perdio o cambio su acceso (desactivado, eliminado o con
 * otro rol). Permite cortar sus conexiones en tiempo real sin que UsersModule dependa del
 * gateway ni revalidar sockets consultando la base periodicamente (costo de Neon).
 */
@Injectable()
export class UserAccessEventsService {
  private readonly emitter = new EventEmitter();

  emitAccessRevoked(userId: string) {
    this.emitter.emit(ACCESS_REVOKED, userId);
  }

  onAccessRevoked(listener: (userId: string) => void) {
    this.emitter.on(ACCESS_REVOKED, listener);
    return () => this.emitter.off(ACCESS_REVOKED, listener);
  }
}
