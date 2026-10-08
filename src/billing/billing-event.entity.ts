import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/** A RevenueCat webhook event already applied: a second delivery of the same id changes nothing. */
@Entity('billing_events')
export class BillingEvent {
  @PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'PK_billing_events_eventId' })
  eventId: string;

  @Column({ type: 'text' })
  type: string;

  @Column({ type: 'text', nullable: true })
  appUserId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  processedAt: Date;
}
