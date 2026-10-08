import { Inject, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { AppTripsModule } from '../app-trips/app-trips.module.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { BillingModule } from '../billing/billing.module.js';
import { UserDeletionHooks } from '../users/user-deletion-hooks.js';
import { Moment } from './moment.entity.js';
import { MomentsService } from './moments.service.js';
import { MomentsController, TripMomentsController } from './moments.controller.js';
import { FilesController } from './files.controller.js';
import { OBJECT_STORAGE } from './storage/object-storage.js';
import type { ObjectStorage } from './storage/object-storage.js';
import { STORAGE_CONFIG, readStorageConfig } from './storage/storage.config.js';
import type { StorageConfig } from './storage/storage.config.js';
import { LocalObjectStorage, localStorageSecret } from './storage/local-storage.js';
import { S3ObjectStorage, createS3Client } from './storage/s3-storage.js';

/** The storage STORAGE_DRIVER selects. */
export function createObjectStorage(config: StorageConfig, settings: ConfigService): ObjectStorage {
  if (config.driver === 's3') return new S3ObjectStorage(config.s3!.bucket, createS3Client(config.s3!));
  const jwtSecret = settings.get<string>('JWT_SECRET');
  if (!jwtSecret) throw new Error('STORAGE_DRIVER=local signs its URLs with JWT_SECRET, which is missing');
  return new LocalObjectStorage(config.localDir, localStorageSecret(jwtSecret));
}

/** Moments and their storage (docs/app-moments-spec.md §2). Startup fails on bad storage settings. */
@Module({
  imports: [TypeOrmModule.forFeature([Moment, TripMember]), AuthModule, AppTripsModule, BillingModule],
  controllers: [MomentsController, TripMomentsController, FilesController],
  providers: [
    { provide: STORAGE_CONFIG, inject: [ConfigService], useFactory: (config: ConfigService) => readStorageConfig(envOf(config)) },
    { provide: OBJECT_STORAGE, inject: [STORAGE_CONFIG, ConfigService], useFactory: createObjectStorage },
    MomentsService,
  ],
  exports: [MomentsService, OBJECT_STORAGE],
})
export class MomentsModule implements OnModuleInit {
  private readonly logger = new Logger(MomentsModule.name);

  constructor(
    private readonly deletionHooks: UserDeletionHooks,
    private readonly moments: MomentsService,
    @Inject(STORAGE_CONFIG) private readonly config: StorageConfig,
  ) {}

  onModuleInit() {
    this.logger.log(`Moments storage: ${this.config.driver}`);
    // `DELETE /me`: the user's moments go, with their objects.
    this.deletionHooks.register((userId) => this.moments.handleUserDeleted(userId));
  }
}

const STORAGE_KEYS = [
  'NODE_ENV',
  'STORAGE_DRIVER',
  'STORAGE_LOCAL_DIR',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_FORCE_PATH_STYLE',
  'FREE_MOMENTS_PER_TRIP',
  'PLUS_MOMENTS_PER_TRIP',
];
function envOf(config: ConfigService): Record<string, string | undefined> {
  return Object.fromEntries(STORAGE_KEYS.map((key) => [key, config.get<string>(key)]));
}
