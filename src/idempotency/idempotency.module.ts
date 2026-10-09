import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdempotencyKey } from './idempotency-key.entity.js';
import { IdempotencyInterceptor, IdempotencyStore } from './idempotency.interceptor.js';

/** `Idempotency-Key` support: import it, then `@UseInterceptors(IdempotencyInterceptor)` on a route. */
@Module({
  imports: [TypeOrmModule.forFeature([IdempotencyKey])],
  providers: [IdempotencyStore, IdempotencyInterceptor],
  exports: [IdempotencyStore, IdempotencyInterceptor],
})
export class IdempotencyModule {}
