import { Controller, Get, HttpStatus, Logger, Res } from '@nestjs/common';
import { AppService } from './app.service';
import { DataSource } from 'typeorm';
import type { Response } from 'express';
import { Public } from './auth/public.decorator';

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);

  constructor(
    private readonly appService: AppService,
    private readonly dataSource: DataSource,
  ) { }

  /**
   * Liveness probe. NO debe tocar la base de datos.
   *
   * Este endpoint lo golpean de forma continua el health check de Render, el
   * cron externo que evita el cold start y el indicador de estado del frontend.
   * Cualquier consulta aqui reinicia el temporizador de autosuspend de Neon
   * (5 min), dejando el compute encendido 24/7 y agotando la cuota mensual.
   * Para verificar la base usar /health/db bajo demanda.
   */
  @Public()
  @Get('health')
  getHealth() {
    return {
      status: 'ok',
      version: process.env.APP_VERSION || '0.1.0',
      commit: process.env.APP_COMMIT || 'unknown',
      uptimeSec: Math.round(process.uptime()),
      time: new Date().toISOString(),
    };
  }

  /** Readiness probe. Consulta la base: usar solo en diagnostico manual. */
  @Public()
  @Get('health/db')
  async getHealthDb(@Res({ passthrough: true }) response?: Response) {
    const startedAt = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      return {
        status: 'ok',
        db: 'ok',
        version: process.env.APP_VERSION || '0.1.0',
        commit: process.env.APP_COMMIT || 'unknown',
        uptimeSec: Math.round(process.uptime()),
        responseMs: Date.now() - startedAt,
        time: new Date().toISOString(),
      };
    } catch (e: any) {
      this.logger.warn(`Database readiness check failed: ${e?.message || 'unknown error'}`);
      response?.status(HttpStatus.SERVICE_UNAVAILABLE);
      return {
        status: 'degraded',
        db: 'down',
        version: process.env.APP_VERSION || '0.1.0',
        commit: process.env.APP_COMMIT || 'unknown',
        uptimeSec: Math.round(process.uptime()),
        responseMs: Date.now() - startedAt,
        time: new Date().toISOString(),
        // El detalle del proveedor queda en logs privados; el endpoint es publico.
        error: 'database_unavailable',
      };
    }
  }
}
