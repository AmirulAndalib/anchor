import { NestFactory } from '@nestjs/core';
import type { ConfigType } from '@nestjs/config';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppConfig } from './config/configuration';
import { setupApp } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  setupApp(app);

  const appConfig = app.get<ConfigType<typeof AppConfig>>(AppConfig.KEY);
  await app.listen(appConfig.port);
}
void bootstrap();
