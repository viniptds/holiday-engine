import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../users/user.entity.js';

/** A refresh token, stored only as the SHA-256 hash of the opaque value given to the client. */
@Entity('refresh_tokens')
@Index('IDX_refresh_tokens_userId', ['userId'])
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_refresh_tokens_id' })
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_refresh_tokens_userId' })
  user?: User;

  // Hex SHA-256 of the token.
  @Index('UQ_refresh_tokens_tokenHash', { unique: true })
  @Column({ type: 'char', length: 64 })
  tokenHash: string;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  // The token issued when this one was rotated.
  @Column({ type: 'uuid', nullable: true })
  replacedById: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
