import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { corsOrigin, parseAllowedOrigins } from './cors';

async function bootstrap() {
  if (process.env.NODE_ENV === 'production' && parseAllowedOrigins().length === 0) {
    throw new Error('CORS_ORIGINS es obligatorio en producción.');
  }
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: corsOrigin });
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }));
  const config = app.get(ConfigService);
  const port = config.get<number>('PORT') ?? 3000;
  // Bind to all interfaces so other devices on the same LAN can reach the API.
  await app.listen(port, '0.0.0.0');
}
bootstrap();
