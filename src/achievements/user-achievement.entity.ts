import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../users/user.entity.js';
import { Trip } from '../trips/trip.entity.js';

/**
 * An achievement a user unlocked (docs/app-moments-spec.md §3). Per-trip keys carry the trip;
 * per-user keys have `tripId` null. Unique on (userId, key, tripId) with NULLs equal: an expression
 * index in the migration (UQ_user_achievements_user_key_trip).
 */
@Entity('user_achievements')
@Index('IDX_user_achievements_userId', ['userId'])
export class UserAchievement {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_user_achievements_id' })
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_user_achievements_userId' })
  user?: User;

  @Column({ type: 'text' })
  key: string;

  @Column({ type: 'uuid', nullable: true })
  tripId: string | null;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tripId', foreignKeyConstraintName: 'FK_user_achievements_tripId' })
  trip?: Trip;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  unlockedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  seenAt: Date | null;
}
