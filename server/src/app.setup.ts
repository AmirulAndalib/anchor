import type { ConfigType } from '@nestjs/config';
import helmet from 'helmet';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as fs from 'fs';
import { AppConfig, StorageConfig } from './config/configuration';
import { PUBLIC_PROFILES_PREFIX } from './config/storage.constants';
import { AppValidationPipe } from './common/pipes/app-validation.pipe';

export function setupApp(app: NestExpressApplication): void {
  const appConfig = app.get<ConfigType<typeof AppConfig>>(AppConfig.KEY);
  const storageConfig = app.get<ConfigType<typeof StorageConfig>>(
    StorageConfig.KEY,
  );

  app.useBodyParser('json', { limit: '30mb' });

  app.use(helmet());

  if (appConfig.corsOrigins.length > 0) {
    app.enableCors({ origin: appConfig.corsOrigins });
  } else {
    app.enableCors();
  }

  for (const dir of [storageConfig.profilesDir, storageConfig.attachmentsDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Serve profile images only
  app.useStaticAssets(storageConfig.profilesDir, {
    prefix: PUBLIC_PROFILES_PREFIX,
  });

  app.useGlobalPipes(new AppValidationPipe());
}
