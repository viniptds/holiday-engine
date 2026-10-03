import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { applyHttpServerTimeouts, httpServerTimeouts } from './http-server.config.js';

async function bootstrap() {
  // Read first, so a bad value fails startup before anything else (`.env` is loaded by the import above).
  const timeouts = httpServerTimeouts(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS);
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  applyHttpServerTimeouts(app.getHttpServer(), timeouts);
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
