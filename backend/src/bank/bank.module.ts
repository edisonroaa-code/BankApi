import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentsModule } from '../payments/payments.module';
import { AtlasClient, readAtlasConfig } from './atlas/atlas-client';
import { BankFeedConfig, readBankFeedConfigSafe } from './bank-feed.config';
import { BankFeedService } from './bank-feed.service';
import { AtlasFeedSource, BankFeedSource, MockFeedSource } from './bank-feed.sources';
import { BANK_FEED_CONFIG, BANK_FEED_SOURCE } from './bank.constants';
import { BankFeedController, BankTransfersController } from './bank-transfers.controller';
import { BankTransfersService } from './bank-transfers.service';

@Module({
  imports: [PaymentsModule],
  controllers: [BankTransfersController, BankFeedController],
  providers: [
    {
      provide: BANK_FEED_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const feed = readBankFeedConfigSafe((key) => config.get<string>(key));
        if (feed.configError) new Logger('BankModule').error(`Feed bancario apagado por configuracion invalida: ${feed.configError}`);
        return feed;
      },
    },
    {
      provide: BANK_FEED_SOURCE,
      inject: [BANK_FEED_CONFIG, ConfigService],
      useFactory: (feed: BankFeedConfig, config: ConfigService): BankFeedSource | null => {
        if (feed.mode === 'mock') return new MockFeedSource(feed);
        if (feed.mode !== 'atlas') return null;
        const { config: atlas, missing } = readAtlasConfig((key) => config.get<string>(key));
        if (!atlas) {
          // Sin credenciales el backend arranca igual; el panel muestra el feed como no configurado.
          new Logger('BankModule').error(`BANK_FEED_MODE=atlas sin configuracion completa: faltan ${missing.join(', ')}.`);
          return null;
        }
        try {
          return new AtlasFeedSource(new AtlasClient(atlas), feed);
        } catch (error: any) {
          // Clave invalida o verificacion sin clave publica: se apaga el feed, no la API.
          new Logger('BankModule').error(`Feed bancario sin iniciar: ${error?.message || error}`);
          return null;
        }
      },
    },
    BankTransfersService,
    BankFeedService,
  ],
})
export class BankModule {}
