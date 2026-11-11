import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from './config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: true });
  app.enableShutdownHooks();
  app.setGlobalPrefix('api');
  await app.listen(config.backendPort, '0.0.0.0');
  console.log(`✅ CE Dashboard Backend: http://0.0.0.0:${config.backendPort}/api`);
}
bootstrap();
