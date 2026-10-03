import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Trip } from '../trips/trip.entity.js';
import type { TripRole } from './app-trips.types.js';

/** A user's membership of an app trip. No FK to users yet: that table arrives with the auth branch. */
@Entity('trip_members')
@Index('IDX_trip_members_userId', ['userId'])
@Check('CHK_trip_members_role', `"role" IN ('owner', 'editor', 'viewer')`)
export class TripMember {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'PK_trip_members' })
  tripId: string;

  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'PK_trip_members' })
  userId: string;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tripId', foreignKeyConstraintName: 'FK_trip_members_tripId' })
  trip?: Trip;

  @Column({ type: 'text' })
  role: TripRole;

  @CreateDateColumn({ type: 'timestamptz' })
  joinedAt: Date;
}
