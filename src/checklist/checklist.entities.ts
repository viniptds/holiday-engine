import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Trip } from '../trips/trip.entity.js';
import { User } from '../users/user.entity.js';

export const CHECKLIST_PRIORITIES = ['high', 'medium', 'low'] as const;
export type ChecklistPriority = (typeof CHECKLIST_PRIORITIES)[number];
export const CHECKLIST_CATEGORIES = ['documents', 'health', 'money', 'packing', 'tech', 'bookings', 'other'] as const;
export type ChecklistCategory = (typeof CHECKLIST_CATEGORIES)[number];

/** A trip checklist item, shared by every member (docs/app-notifications-checklist-calendar-spec.md). */
@Entity('checklist_items')
@Index('IDX_checklist_items_tripId_position', ['tripId', 'position'])
@Check('CHK_checklist_items_priority', `"priority" IN ('high', 'medium', 'low')`)
@Check('CHK_checklist_items_category', `"category" IN ('documents', 'health', 'money', 'packing', 'tech', 'bookings', 'other')`)
@Check('CHK_checklist_items_source', `"source" IN ('ai', 'user')`)
export class ChecklistItem {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_checklist_items_id' })
  id: string;

  @Column({ type: 'uuid' })
  tripId: string;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tripId', foreignKeyConstraintName: 'FK_checklist_items_tripId' })
  trip?: Trip;

  @Column({ type: 'varchar', length: 120 })
  title: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string | null;

  @Column({ type: 'text' })
  priority: ChecklistPriority;

  @Column({ type: 'text' })
  category: ChecklistCategory;

  @Column({ type: 'boolean', default: false })
  done: boolean;

  @Column({ type: 'uuid', nullable: true })
  doneBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'doneBy', foreignKeyConstraintName: 'FK_checklist_items_doneBy' })
  doneByUser?: User;

  @Column({ type: 'timestamptz', nullable: true })
  doneAt: Date | null;

  @Column({ type: 'int', default: 0 })
  position: number;

  @Column({ type: 'text', default: 'user' })
  source: 'ai' | 'user';

  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'createdBy', foreignKeyConstraintName: 'FK_checklist_items_createdBy' })
  creator?: User;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

/** A member's personal reminder for an item: one per item and user. */
@Entity('checklist_reminders')
@Index('IDX_checklist_reminders_due', ['sentAt', 'remindAt'])
export class ChecklistReminder {
  @PrimaryColumn('uuid', { primaryKeyConstraintName: 'PK_checklist_reminders' })
  itemId: string;

  @PrimaryColumn('uuid', { primaryKeyConstraintName: 'PK_checklist_reminders' })
  userId: string;

  @ManyToOne(() => ChecklistItem, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'itemId', foreignKeyConstraintName: 'FK_checklist_reminders_itemId' })
  item?: ChecklistItem;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_checklist_reminders_userId' })
  user?: User;

  @Column({ type: 'timestamptz' })
  remindAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;
}
