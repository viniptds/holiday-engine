import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { Trip } from '../trips/trip.entity.js';

/** An event already sent to a trip's chat by the scheduler, so it isn't suggested twice. */
@Entity('suggested_events')
@Unique('UQ_suggested_events_tripId_externalId', ['tripId', 'externalId'])
export class SuggestedEvent {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_suggested_events_id' })
  id: string;

  @Column({ type: 'uuid' })
  tripId: string;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tripId', foreignKeyConstraintName: 'FK_suggested_events_tripId' })
  trip?: Trip;

  @Column({ type: 'text' })
  externalId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  sentAt: Date;
}
