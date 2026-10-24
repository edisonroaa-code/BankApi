import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DataSource } from 'typeorm';

describe('AppController', () => {
  let appController: AppController;
  let dataSource: { query: jest.Mock };

  beforeEach(async () => {
    dataSource = {
      query: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };

    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: DataSource,
          useValue: dataSource,
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('health (liveness)', () => {
    it('should report ok without touching the database', () => {
      const result = appController.getHealth();

      // Critico: este endpoint lo pinguean Render y el cron externo de forma
      // continua. Si consulta la base, Neon nunca se autosuspende.
      expect(dataSource.query).not.toHaveBeenCalled();
      expect(result.status).toBe('ok');
      expect(result.uptimeSec).toEqual(expect.any(Number));
    });
  });

  describe('health/db (readiness)', () => {
    it('should report ok when the database responds', async () => {
      const result = await appController.getHealthDb();

      expect(dataSource.query).toHaveBeenCalledWith('SELECT 1');
      expect(result.status).toBe('ok');
      expect(result.db).toBe('ok');
      expect(result.responseMs).toEqual(expect.any(Number));
    });

    it('should return HTTP 503 without exposing provider details when the database query fails', async () => {
      dataSource.query.mockRejectedValueOnce(new Error('connection failed'));
      const httpResponse = { status: jest.fn() };

      const result = await (appController.getHealthDb as any)(httpResponse);

      expect(httpResponse.status).toHaveBeenCalledWith(503);
      expect(result.status).toBe('degraded');
      expect(result.db).toBe('down');
      expect(result.error).toBe('database_unavailable');
      expect(JSON.stringify(result)).not.toContain('connection failed');
    });
  });
});
