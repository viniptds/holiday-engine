import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { User } from '../users/user.entity.js';

/**
 * A profile picture upload not completed yet (`pending`), or a replaced picture whose object
 * couldn't be deleted (`orphan`). The cleanup removes both, like pending moments.
 */
@Entity('avatar_uploads')
@Index('IDX_avatar_uploads_status_createdAt', ['status', 'createdAt'])
export class AvatarUpload {
  @PrimaryColumn('uuid', { primaryKeyConstraintName: 'PK_avatar_uploads_id' })
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_avatar_uploads_userId' })
  user?: User;

  @Column({ type: 'text' })
  objectKey: string;

  @Column({ type: 'int' })
  byteSize: number;

  @Column({ type: 'text', default: 'pending' })
  status: 'pending' | 'orphan';

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
