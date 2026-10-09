import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../users/user.entity.js';
import { Trip } from '../trips/trip.entity.js';

/** An Expo push token of one of the user's devices. A token belongs to one user (unique). */
@Entity('push_tokens')
@Index('IDX_push_tokens_userId', ['userId'])
export class PushToken {
  @PrimaryColumn('text', { primaryKeyConstraintName: 'PK_push_tokens_token' })
  token: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_push_tokens_userId' })
  user?: User;

  @Column({ type: 'text' })
  platform: string;

  @Column({ type: 'text', nullable: true })
  deviceId: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  lastSeenAt: Date;
}

/** An inbox entry, rendered at send time in the recipient's language. */
@Entity('notifications')
@Index('IDX_notifications_userId_createdAt', ['userId', 'createdAt'])
export class Notification {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_notifications_id' })
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_notifications_userId' })
  user?: User;

  @Column({ type: 'text' })
  type: string;

  // SET NULL: the entry stays in the inbox after the trip is deleted (its link then goes nowhere).
  @Column({ type: 'uuid', nullable: true })
  tripId: string | null;

  @ManyToOne(() => Trip, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'tripId', foreignKeyConstraintName: 'FK_notifications_tripId' })
  trip?: Trip;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text' })
  body: string;

  /** The deep link: `{ route }` (plus ids). */
  @Column({ type: 'jsonb' })
  data: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  readAt: Date | null;
}

export type JobStatus = 'pending' | 'sending' | 'sent' | 'skipped' | 'failed';

/**
 * A scheduled or combined send, done exactly once: unique on (userId, type, tripId, itemId, dueAt)
 * (an expression index with NULL trip ids equal), claimed `pending → sending` before sending.
 */
@Entity('notification_jobs')
@Index('IDX_notification_jobs_status_dueAt', ['status', 'dueAt'])
export class NotificationJob {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_notification_jobs_id' })
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_notification_jobs_userId' })
  user?: User;

  @Column({ type: 'text' })
  type: string;

  @Column({ type: 'uuid', nullable: true })
  tripId: string | null;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tripId', foreignKeyConstraintName: 'FK_notification_jobs_tripId' })
  trip?: Trip;

  /** A checklist item id, a countdown offset, or '' (combined activity). */
  @Column({ type: 'text', default: '' })
  itemId: string;

  @Column({ type: 'timestamptz' })
  dueAt: Date;

  @Column({ type: 'text', default: 'pending' })
  status: JobStatus;

  /** Combined activity: `{ count, actorIds }`. */
  @Column({ type: 'jsonb', nullable: true })
  payload: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

/** An Expo push ticket awaiting its receipt (checked after 15 minutes, dropped after 24 hours). */
@Entity('push_tickets')
export class PushTicket {
  @PrimaryColumn('text', { primaryKeyConstraintName: 'PK_push_tickets_id' })
  id: string;

  @Column({ type: 'text' })
  token: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
