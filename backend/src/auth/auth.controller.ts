import { Controller, Post, Body, Request, UnauthorizedException } from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import { isIP } from 'net';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { LoginAttemptLimiter } from './login-attempt-limiter';
import { Public } from './public.decorator';

/** Render sobrescribe CF-Connecting-IP en sus web services; no confiar en X-Forwarded-For. */
export const clientAddressForLogin = (
    request: Pick<ExpressRequest, 'headers' | 'socket'>,
    renderWeb = process.env.RENDER === 'true' && process.env.RENDER_SERVICE_TYPE === 'web',
): string => {
    const cloudflare = request.headers['cf-connecting-ip'];
    if (renderWeb && typeof cloudflare === 'string' && isIP(cloudflare)) return cloudflare;
    const peer = request.socket?.remoteAddress;
    return peer && isIP(peer) ? peer : 'unknown';
};

@Controller('auth')
export class AuthController {
    constructor(
        private authService: AuthService,
        private readonly loginAttempts: LoginAttemptLimiter,
    ) { }

    @Public()
    @Post('login')
    async login(@Body() body: LoginDto, @Request() req: ExpressRequest) {
        const reservation = this.loginAttempts.begin(body.username, clientAddressForLogin(req));
        let finished = false;
        try {
            const user = await this.authService.validateUser(body.username, body.password);
            if (!user) {
                this.loginAttempts.failure(reservation);
                finished = true;
                throw new UnauthorizedException('Invalid credentials');
            }
            const response = await this.authService.login(user);
            this.loginAttempts.success(reservation);
            finished = true;
            return response;
        } finally {
            // Ante un error interno tampoco permitir intentos ilimitados contra bcrypt/DB.
            if (!finished) this.loginAttempts.failure(reservation);
        }
    }
}
