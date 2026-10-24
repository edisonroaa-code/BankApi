import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { existsSync } from 'fs';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UsersModule } from './users/users.module';
import { PaymentsModule } from './payments/payments.module';
import { AuthModule } from './auth/auth.module';
import { StorageModule } from './storage/storage.module';
import { BankModule } from './bank/bank.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { DatabaseIndexesService } from './database-indexes.service';
import { buildTypeOrmOptions } from './database/typeorm-options';
import { SPA_EXCLUDED_ROUTES } from './spa-routes';

/**
 * Resolve frontend dist path for serving the PWA to mobile devices.
 * Priority:
 *   1. FRONTEND_DIST_PATH env var (set by Electron when spawning backend)
 *   2. <backendDir>/public  (production packaging puts it here)
 *   3. <repoRoot>/dist      (development fallback)
 */
const resolveFrontendDistPath = (): string | null => {
  const candidates: string[] = [];
  if (process.env.FRONTEND_DIST_PATH) {
    candidates.push(process.env.FRONTEND_DIST_PATH);
  }
  candidates.push(
    join(__dirname, '..', 'public'),       // production: resources/backend/public
    join(__dirname, '..', '..', 'dist'),   // dev: repo root dist
  );
  for (const p of candidates) {
    if (existsSync(join(p, 'index.html'))) return p;
  }
  return null;
};

const frontendDistPath = resolveFrontendDistPath();

// Los comprobantes locales, incluso los históricos, sólo se entregan por
// GET /payments/:id/proof con JWT y control de alcance.
const staticModules: ReturnType<typeof ServeStaticModule.forRoot>[] = [];
if (frontendDistPath) {
  staticModules.push(
    ServeStaticModule.forRoot({
      rootPath: frontendDistPath,
      exclude: SPA_EXCLUDED_ROUTES,
    }),
  );
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Ensure env loads even if the process is started from repo root
      // (covers both `backend/.env` and `.env` in current working dir).
      envFilePath: [
        join(process.cwd(), '.env'),
        join(process.cwd(), 'backend', '.env'),
      ],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        buildTypeOrmOptions((key) => configService.get<string>(key)),
    }),
    UsersModule,
    PaymentsModule,
    AuthModule,
    BankModule,
    ...staticModules,
    StorageModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    DatabaseIndexesService,
    // El orden importa: primero autenticar (JWT), despues autorizar por rol.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule { }
