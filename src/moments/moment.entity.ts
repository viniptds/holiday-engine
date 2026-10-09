import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { User } from '../users/user.entity.js';
import { Trip } from '../trips/trip.entity.js';

export type MomentStatus = 'pending' | 'ready';
/** camera: taken in the app, its day follows takenAt (locked). upload: picked from the library, its day can change. */
export type MomentSource = 'camera' | 'upload';

/**
 * A photo a user took (docs/app-moments-spec.md §2). `tripId` null = unassigned (only its author
 * sees it). `pending` until the upload is verified. The image lives in object storage at `objectKey`.
 */
@Entity('moments')
@Index('IDX_moments_tripId_status', ['tripId', 'status'])
@Index('IDX_moments_userId', ['userId'])
@Index('IDX_moments_status_createdAt', ['status', 'createdAt'])
@Check('CHK_moments_status', `"status" IN ('pending', 'ready')`)
@Check('CHK_moments_byteSize', '"byteSize" BETWEEN 1 AND 10485760')
@Check('CHK_moments_source', `"source" IN ('camera', 'upload')`)
@Check('CHK_moments_day', '"day" >= 1')
export class Moment {
  @PrimaryColumn('uuid', { primaryKeyConstraintName: 'PK_moments_id' })
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_moments_userId' })
  user?: User;

  // SET NULL: a deleted trip leaves its photos with their authors, unassigned.
  @Column({ type: 'uuid', nullable: true })
  tripId: string | null;

  @ManyToOne(() => Trip, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'tripId', foreignKeyConstraintName: 'FK_moments_tripId' })
  trip?: Trip;

  @Column({ type: 'text' })
  status: MomentStatus;

  @Column({ type: 'text', default: 'camera' })
  source: MomentSource;

  /** The trip day (1…tripDays) or null (no day). Camera: from takenAt at complete; upload: chosen. */
  @Column({ type: 'smallint', nullable: true })
  day: number | null;

  @Column({ type: 'text', unique: false })
  objectKey: string;

  @Column({ type: 'text' })
  contentType: string;

  @Column({ type: 'int' })
  byteSize: number;

  @Column({ type: 'int' })
  width: number;

  @Column({ type: 'int' })
  height: number;

  @Column({ type: 'timestamptz' })
  takenAt: Date;

  /** The local date it was taken on (the uploader's time zone), for Journey days. */
  @Column({ type: 'date' })
  takenOn: string;

  @Column({ type: 'double precision', nullable: true })
  lat: number | null;

  @Column({ type: 'double precision', nullable: true })
  lng: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;
}
