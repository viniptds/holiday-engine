import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Trip } from '../trips/trip.entity.js';
import { User } from '../users/user.entity.js';

/**
 * A Journey step skipped for the whole trip (docs/app-trip-detail-v2-spec.md). One per trip and
 * key. A skip never awards an achievement; completing the step later still shows it done.
 */
@Entity('trip_journey_skips')
export class TripJourneySkip {
  @PrimaryColumn('uuid', { primaryKeyConstraintName: 'PK_trip_journey_skips' })
  tripId: string;

  @PrimaryColumn('text')
  key: string;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tripId', foreignKeyConstraintName: 'FK_trip_journey_skips_tripId' })
  trip?: Trip;

  // SET NULL: the skip stays when its author deletes their account.
  @Column({ type: 'uuid', nullable: true })
  skippedBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'skippedBy', foreignKeyConstraintName: 'FK_trip_journey_skips_skippedBy' })
  skipper?: User;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  skippedAt: Date;
}
