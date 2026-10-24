import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';
import { hasCurrentTokenVersion } from './token-version';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor(configService: ConfigService, private usersService: UsersService) {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            secretOrKey: configService.get<string>('JWT_SECRET'),
        });
    }

    async validate(payload: any) {
        const userId = payload?.sub;
        if (!userId) throw new UnauthorizedException('Token inválido');

        const user = await this.usersService.findOneById(userId);
        if (!user || !user.isActive) {
            throw new UnauthorizedException('Usuario inactivo');
        }
        if (!hasCurrentTokenVersion(payload.tokenVersion, user.tokenVersion)) {
            throw new UnauthorizedException('Sesión invalidada');
        }

        return { userId: user.id, username: user.username, name: user.name, role: user.role };
    }
}
