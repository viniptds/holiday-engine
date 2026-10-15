import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { applyHttpServerTimeouts, httpServerTimeouts } from './http-server.config.js';
import { applyTrustProxy, trustProxySetting } from './trust-proxy.config.js';

async function bootstrap() {
  // Read first, so a bad value fails startup before anything else (`.env` is loaded by the import above).
  const timeouts = httpServerTimeouts(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS);
  const trustProxy = trustProxySetting(process.env.TRUST_PROXY);
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  applyTrustProxy(app, trustProxy);
  app.enableShutdownHooks();
  applyHttpServerTimeouts(app.getHttpServer(), timeouts);
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
