import type { NotificationPrefs } from '../notifications/notification-prefs.js';

export type AvatarSource = 'google' | 'custom' | 'none';
import { Check, Column, CreateDateColumn, DeleteDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * An app user, signed in with Google. Soft-deleted through `deletedAt`: TypeORM hides those rows
 * from every `find`, and `googleSub` is unique only among live rows, so a returning Google account
 * gets a new user instead of the deleted one.
 */
@Entity('users')
@Check('CHK_users_avatarSource', `"avatarSource" IN ('google', 'custom', 'none')`)
@Index('UQ_users_googleSub_active', ['googleSub'], { unique: true, where: '"deletedAt" IS NULL' })
export class User {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_users_id' })
  id: string;

  @Column({ type: 'text' })
  googleSub: string;

  @Column({ type: 'varchar', length: 320 })
  email: string;

  @Column({ type: 'varchar', length: 100 })
  displayName: string;

  /**
   * The displayed picture when it isn't custom (Google's, or null for none). A custom picture is
   * served as a signed URL computed on read (`UsersService.avatarUrlOf`).
   */
  @Column({ type: 'text', nullable: true })
  avatarUrl: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  homeCity: string | null;

  /** The latest valid IANA zone the app sent (`X-Timezone`); null until it sends one. */
  @Column({ type: 'text', nullable: true })
  timezone: string | null;

  /** Which picture `avatarUrl` shows: Google's, an uploaded one (`avatarKey`), or none (the initial). */
  @Column({ type: 'text', default: 'google' })
  avatarSource: AvatarSource;

  /** The latest Google picture, refreshed on every Google sign-in (shown only while avatarSource is google). */
  @Column({ type: 'text', nullable: true })
  googlePictureUrl: string | null;

  /** The stored object of a custom picture (`avatars/<userId>/<uuid>.jpg`). */
  @Column({ type: 'text', nullable: true })
  avatarKey: string | null;

  /** The app's language (from Accept-Language), for notifications rendered at send time. */
  @Column({ type: 'text', nullable: true })
  locale: string | null;

  /** docs/app-notifications-checklist-calendar-spec.md; null = all on (the default). */
  @Column({ type: 'jsonb', nullable: true })
  notificationPrefs: NotificationPrefs | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
