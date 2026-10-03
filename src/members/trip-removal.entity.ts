import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Trip } from '../trips/trip.entity.js';
import { User } from '../users/user.entity.js';

/**
 * A member removed from a trip by its owner (leaving isn't a removal). While it exists, the user
 * can't rejoin through a link invite; accepting an email invite created after `removedAt` lifts it.
 */
@Entity('trip_removals')
@Index('IDX_trip_removals_userId', ['userId'])
export class TripRemoval {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'PK_trip_removals' })
  tripId: string;

  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'PK_trip_removals' })
  userId: string;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tripId', foreignKeyConstraintName: 'FK_trip_removals_tripId' })
  trip?: Trip;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_trip_removals_userId' })
  user?: User;

  // Who removed them; kept null if that account is hard-deleted.
  @Column({ type: 'uuid', nullable: true })
  removedBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'removedBy', foreignKeyConstraintName: 'FK_trip_removals_removedBy' })
  remover?: User | null;

  @Column({ type: 'timestamptz' })
  removedAt: Date;
}
