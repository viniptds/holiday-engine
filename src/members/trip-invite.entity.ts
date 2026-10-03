import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { Trip } from '../trips/trip.entity.js';
import { User } from '../users/user.entity.js';
import type { InviteRole } from './members.types.js';

/**
 * An invitation to join a trip. Only the SHA-256 of the token is stored. Email invites are
 * single use (`acceptedBy`/`acceptedAt` set on accept); link invites stay usable until they
 * expire or are revoked.
 */
@Entity('trip_invites')
@Unique('UQ_trip_invites_tokenHash', ['tokenHash'])
@Index('IDX_trip_invites_tripId', ['tripId'])
@Index('IDX_trip_invites_createdBy', ['createdBy'])
@Check('CHK_trip_invites_role', `"role" IN ('editor', 'viewer')`)
export class TripInvite {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_trip_invites_id' })
  id: string;

  @Column({ type: 'uuid' })
  tripId: string;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tripId', foreignKeyConstraintName: 'FK_trip_invites_tripId' })
  trip?: Trip;

  @Column({ type: 'varchar', length: 254, nullable: true })
  email: string | null;

  // Hex SHA-256 of the token.
  @Column({ type: 'varchar', length: 64 })
  tokenHash: string;

  @Column({ type: 'text' })
  role: InviteRole;

  @Column({ type: 'uuid' })
  createdBy: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'createdBy', foreignKeyConstraintName: 'FK_trip_invites_createdBy' })
  creator?: User;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'uuid', nullable: true })
  acceptedBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'acceptedBy', foreignKeyConstraintName: 'FK_trip_invites_acceptedBy' })
  acceptor?: User | null;

  @Column({ type: 'timestamptz', nullable: true })
  acceptedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
