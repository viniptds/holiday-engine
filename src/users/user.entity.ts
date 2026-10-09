import type { NotificationPrefs } from '../notifications/notification-prefs.js';
import { Column, CreateDateColumn, DeleteDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * An app user, signed in with Google. Soft-deleted through `deletedAt`: TypeORM hides those rows
 * from every `find`, and `googleSub` is unique only among live rows, so a returning Google account
 * gets a new user instead of the deleted one.
 */
@Entity('users')
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

  @Column({ type: 'text', nullable: true })
  avatarUrl: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  homeCity: string | null;

  /** The latest valid IANA zone the app sent (`X-Timezone`); null until it sends one. */
  @Column({ type: 'text', nullable: true })
  timezone: string | null;

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
