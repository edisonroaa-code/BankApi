import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
    constructor(
        private usersService: UsersService,
        private jwtService: JwtService,
    ) { }

    async validateUser(username: string, pass: string): Promise<any> {
        const user = await this.usersService.findOneByUsername(username);
        if (!user) return null;
        if (!user.isActive || user.deletedAt) return null;

        if (await bcrypt.compare(pass, user.password || '')) {
            const { password, ...result } = user;
            return result;
        }
        return null;
    }

    async login(user: any) {
        if (!Number.isSafeInteger(user.tokenVersion) || user.tokenVersion < 0) {
            throw new UnauthorizedException('Usuario sin versión de sesión válida');
        }
        const payload = {
            username: user.username,
            name: user.name,
            sub: user.id,
            role: user.role,
            tokenVersion: user.tokenVersion,
        };
        return {
            access_token: this.jwtService.sign(payload),
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
                name: user.name,
            }
        };
    }
}
