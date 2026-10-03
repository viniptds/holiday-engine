import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { PartyType, TravelerProfile } from '../app-trips/app-trips.types.js';
import { User } from '../users/user.entity.js';

/**
 * A trip. Bot trips belong to a chat (`provider` + `chatId`); app trips belong to users
 * (`ownerUserId`, plus `trip_members`) and have no chat.
 */
@Entity('trips')
@Index('IDX_trips_provider_chatId', ['provider', 'chatId'])
@Index('IDX_trips_dates', ['startDate', 'endDate'])
@Check('CHK_trips_dates', '"endDate" >= "startDate"')
@Check('CHK_trips_owner', '("provider" IS NOT NULL AND "chatId" IS NOT NULL) OR "ownerUserId" IS NOT NULL')
@Check('CHK_trips_partyType', `"partyType" IN ('solo', 'couple', 'family', 'friends', 'work')`)
@Check('CHK_trips_partySize', '"partySize" BETWEEN 1 AND 20')
export class Trip {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_trips_id' })
  id: string;

  // Null for app trips.
  @Column({ type: 'text', nullable: true })
  provider: string | null;

  // Text, not int: Telegram chat ids can exceed 2^31 and may be negative. Null for app trips.
  @Column({ type: 'text', nullable: true })
  chatId: string | null;

  // App trips: the owning user. Null for bot trips. RESTRICT: see AddUserForeignKeys1760190000000.
  @Column({ type: 'uuid', nullable: true })
  ownerUserId: string | null;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'ownerUserId', foreignKeyConstraintName: 'FK_trips_ownerUserId' })
  owner?: User;

  @Column({ type: 'varchar', length: 100 })
  destination: string;

  // Postgres `date` columns are hydrated by TypeORM as `YYYY-MM-DD` strings.
  @Column({ type: 'date' })
  startDate: string;

  @Column({ type: 'date' })
  endDate: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  story: string | null;

  @Column({ type: 'text', nullable: true })
  partyType: PartyType | null;

  @Column({ type: 'smallint', nullable: true })
  partySize: number | null;

  @Column({ type: 'jsonb', nullable: true })
  travelerProfile: TravelerProfile | null;

  /**
   * App trips' itinerary version (optimistic concurrency): +1 on every itinerary change, always
   * under the trip row lock. Never written from a trip loaded without that lock.
   */
  @Column({ type: 'int', default: 0 })
  itineraryVersion: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
