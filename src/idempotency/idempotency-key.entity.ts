import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { User } from '../users/user.entity.js';

/**
 * A replayable write (docs/app-profile-offline-spec.md §2): the response of the first request with
 * this `Idempotency-Key`, per user, kept 24 h. `status` 0 while the first request is still running.
 */
@Entity('idempotency_keys')
@Index('IDX_idempotency_keys_createdAt', ['createdAt'])
export class IdempotencyKey {
  @PrimaryColumn('uuid', { primaryKeyConstraintName: 'PK_idempotency_keys' })
  userId: string;

  @PrimaryColumn('uuid', { primaryKeyConstraintName: 'PK_idempotency_keys' })
  key: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_idempotency_keys_userId' })
  user?: User;

  @Column({ type: 'text' })
  method: string;

  @Column({ type: 'text' })
  path: string;

  @Column({ type: 'smallint', default: 0 })
  status: number;

  @Column({ type: 'jsonb', nullable: true })
  responseBody: object | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
