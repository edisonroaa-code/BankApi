import { Injectable, OnModuleDestroy, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConnectedSocket, OnGatewayConnection, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { UsersService } from '../users/users.service';
import { UserAccessEventsService } from '../users/user-access-events.service';
import { corsOrigin } from '../cors';
import { hasCurrentTokenVersion } from '../auth/token-version';
import { canOpenBankPanel, ROOMS, roomsForRole } from './realtime-rooms';

export type PaymentsRealtimeEvent = {
  type: string;
  paymentId?: string;
  targetUserId?: string;
  ts: string;
};

export const userRoom = (userId: string) => `user:${userId}`;

@Injectable()
@WebSocketGateway({
  namespace: '/realtime',
  cors: { origin: corsOrigin, credentials: true },
})
export class PaymentsGateway implements OnGatewayConnection, OnModuleDestroy {
  @WebSocketServer()
  server: Server;

  private readonly stopListeningAccess: () => void;
  private readonly expiryTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly demandListeners = new Set<() => void>();

  constructor(
    private jwtService: JwtService,
    private usersService: UsersService,
    accessEvents: UserAccessEventsService,
  ) {
    // El socket se valida solo al conectar. El evento local corta conexiones cuando
    // una operación HTTP cambia acceso o clave. Un reset CLI o una mutación en otra
    // instancia no emite aquí: esos sockets siguen hasta desconexión/reconexión.
    this.stopListeningAccess = accessEvents.onAccessRevoked((userId) => this.disconnectUser(userId));
  }

  onModuleDestroy() {
    this.stopListeningAccess();
    for (const timer of this.expiryTimers) clearTimeout(timer);
    this.expiryTimers.clear();
  }

  async handleConnection(client: Socket) {
    // socket.io entrega mensajes sin esperar a que termine esta autenticacion asincronica: un panel
    // que avisa "abierto" apenas conecta llegaria antes de saber el rol. Los handlers esperan esto.
    let authenticated!: () => void;
    client.data.ready = new Promise<void>((resolve) => (authenticated = resolve));
    try {
      const token =
        (client.handshake.auth as any)?.token ||
        (typeof client.handshake.query?.token === 'string' ? client.handshake.query.token : undefined);

      if (!token) throw new UnauthorizedException('Token requerido');

      const payload: any = await this.jwtService.verifyAsync(token);
      const userId = payload?.sub;
      if (!userId) throw new UnauthorizedException('Token inválido');

      const user = await this.usersService.findOneById(userId);
      if (!user || !user.isActive) throw new UnauthorizedException('Usuario inactivo');
      if (!hasCurrentTokenVersion(payload.tokenVersion, user.tokenVersion)) {
        throw new UnauthorizedException('Sesión invalidada');
      }
      const expiresAt = Number(payload.exp) * 1000;
      if (!Number.isSafeInteger(payload.exp) || expiresAt <= Date.now()) {
        throw new UnauthorizedException('Token sin vencimiento válido');
      }

      client.data.user = { userId: user.id, username: user.username, role: user.role };
      await client.join([userRoom(user.id), ...roomsForRole(user.role)]);
      // verifyAsync valida al conectar; una conexion abierta no vuelve a pasar por el guard HTTP.
      const timer = setTimeout(() => {
        this.expiryTimers.delete(timer);
        client.disconnect(true);
      }, Math.min(expiresAt - Date.now(), 2_147_483_647));
      timer.unref?.();
      this.expiryTimers.add(timer);
      client.once?.('disconnect', () => {
        clearTimeout(timer);
        this.expiryTimers.delete(timer);
      });
    } catch {
      client.disconnect(true);
    } finally {
      authenticated();
    }
  }

  disconnectUser(userId: string) {
    this.server?.in(userRoom(userId)).disconnectSockets(true);
  }

  emitPaymentsChanged(event: Omit<PaymentsRealtimeEvent, 'ts'> & { ts?: string }) {
    const payload: PaymentsRealtimeEvent = {
      ts: event.ts ?? new Date().toISOString(),
      type: event.type,
      paymentId: event.paymentId,
      targetUserId: event.targetUserId,
    };
    this.server?.to(ROOMS.payments).emit('payments:changed', payload);
  }

  emitToRoom(room: string, event: string, payload: unknown) {
    this.server?.to(room).emit(event, payload);
  }

  /**
   * El panel de transferencias avisa que esta abierto y visible. Solo los roles que pueden ver el
   * feed entran a la sala de demanda; el resto recibe `false` y no genera consultas al banco.
   * No hace falta latido propio: si la conexion se corta, socket.io la cierra por ping y el
   * socket sale solo de la sala.
   */
  @SubscribeMessage('bank-panel:open')
  async openBankPanel(@ConnectedSocket() client: Socket): Promise<{ ok: boolean }> {
    await client.data?.ready;
    if (!client.connected || !canOpenBankPanel(client.data?.user?.role)) return { ok: false };
    const wasIdle = this.countInRoom(ROOMS.bankDemand) === 0;
    await client.join(ROOMS.bankDemand);
    if (wasIdle) for (const listener of this.demandListeners) listener();
    return { ok: true };
  }

  /** El panel se cerro o la pestana quedo oculta: deja de pedir datos al banco. */
  @SubscribeMessage('bank-panel:close')
  async closeBankPanel(@ConnectedSocket() client: Socket): Promise<{ ok: boolean }> {
    await client.leave(ROOMS.bankDemand);
    return { ok: true };
  }

  /** Avisa cuando se abre el primer panel, para no esperar el proximo ciclo del sondeo. */
  onBankDemand(listener: () => void): () => void {
    this.demandListeners.add(listener);
    return () => this.demandListeners.delete(listener);
  }

  /** Conexiones activas en una sala: el feed del banco solo consulta si alguien esta mirando. */
  countInRoom(room: string): number {
    return (this.server as any)?.adapter?.rooms?.get(room)?.size ?? 0;
  }
}
