import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Trip } from '../../trips/trip.entity.js';
import { User } from '../../users/user.entity.js';
import type { ConversationStatus } from '../ai.types.js';

/** A trip-planning chat with the AI. Visible only to its author (`userId`), even when linked to a trip. */
@Entity('ai_conversations')
@Index('IDX_ai_conversations_userId_updatedAt', ['userId', 'updatedAt'])
@Index('IDX_ai_conversations_tripId', ['tripId'])
@Check('CHK_ai_conversations_status', `"status" IN ('open', 'confirmed', 'abandoned')`)
export class AiConversation {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_ai_conversations_id' })
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_ai_conversations_userId' })
  user?: User;

  // The trip it adds places to (set at start), or the trip created on confirm.
  @Column({ type: 'uuid', nullable: true })
  tripId: string | null;

  @ManyToOne(() => Trip, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'tripId', foreignKeyConstraintName: 'FK_ai_conversations_tripId' })
  trip?: Trip;

  @Column({ type: 'text' })
  status: ConversationStatus;

  // The draft's destination once known.
  @Column({ type: 'varchar', length: 100, nullable: true })
  title: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
