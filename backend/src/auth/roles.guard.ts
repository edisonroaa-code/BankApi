import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';
import { UserRole } from '../users/entities/user.entity';

/**
 * Guard global de autorizacion con denegacion por defecto: un endpoint sin @Roles()
 * ni @Public() responde 403. Asi un rol nuevo no hereda acceso a endpoints olvidados.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) { }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, targets);
    if (!requiredRoles || requiredRoles.length === 0) {
      throw new ForbiddenException('Endpoint sin roles declarados');
    }

    const { user } = context.switchToHttp().getRequest();
    if (!user?.role) {
      throw new ForbiddenException('Rol no establecido');
    }

    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException('No tiene permisos suficientes');
    }

    return true;
  }
}
