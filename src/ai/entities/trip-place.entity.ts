import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { Trip } from '../../trips/trip.entity.js';
import { User } from '../../users/user.entity.js';
import type { PlaceCategory, PlaceSource } from '../ai.types.js';

/** A verified place saved on a trip. Stays with the trip when its creator deletes their account. */
@Entity('trip_places')
@Unique('UQ_trip_places_tripId_googlePlaceId', ['tripId', 'googlePlaceId'])
@Check('CHK_trip_places_category', `"category" IN ('food', 'sight', 'nature', 'nightlife', 'shopping', 'activity', 'stay', 'other')`)
@Check('CHK_trip_places_day', '"day" >= 1')
@Check('CHK_trip_places_source', `"source" IN ('ai', 'user')`)
export class TripPlace {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_trip_places_id' })
  id: string;

  @Column({ type: 'uuid' })
  tripId: string;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tripId', foreignKeyConstraintName: 'FK_trip_places_tripId' })
  trip?: Trip;

  @Column({ type: 'text' })
  googlePlaceId: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'text' })
  category: PlaceCategory;

  @Column({ type: 'smallint', nullable: true })
  day: number | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string | null;

  @Column({ type: 'text' })
  address: string;

  @Column({ type: 'double precision' })
  lat: number;

  @Column({ type: 'double precision' })
  lng: number;

  @Column({ type: 'real', nullable: true })
  rating: number | null;

  @Column({ type: 'text', nullable: true })
  mapsUrl: string | null;

  @Column({ type: 'text', array: true, default: () => `'{}'` })
  types: string[];

  @Column({ type: 'text' })
  source: PlaceSource;

  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'createdBy', foreignKeyConstraintName: 'FK_trip_places_createdBy' })
  creator?: User;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
