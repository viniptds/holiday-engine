import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import { User } from '../users/user.entity.js';

export const ENTITLEMENT_STORES = ['app_store', 'play_store', 'promotional', 'dev'] as const;
export type EntitlementStore = (typeof ENTITLEMENT_STORES)[number];
export const ENTITLEMENT_STATUSES = ['active', 'grace', 'expired'] as const;
export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number];

/** A user's store entitlement (`plus`): the source of truth for "is Plus". */
@Entity('user_entitlements')
@Unique('UQ_user_entitlements_userId_entitlement', ['userId', 'entitlement'])
@Check('CHK_user_entitlements_store', `"store" IN ('app_store', 'play_store', 'promotional', 'dev')`)
@Check('CHK_user_entitlements_status', `"status" IN ('active', 'grace', 'expired')`)
export class UserEntitlement {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_user_entitlements_id' })
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_user_entitlements_userId' })
  user?: User;

  @Column({ type: 'text' })
  entitlement: string;

  @Column({ type: 'text' })
  store: EntitlementStore;

  @Column({ type: 'text', nullable: true })
  productId: string | null;

  @Column({ type: 'text' })
  status: EntitlementStatus;

  /** null = lifetime or promotional without an end. */
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'boolean', nullable: true })
  willRenew: boolean | null;

  @Column({ type: 'text', nullable: true })
  lastEventId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
