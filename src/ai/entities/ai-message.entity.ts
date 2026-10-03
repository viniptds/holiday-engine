import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import type { MessageRole, TripDraft } from '../ai.types.js';
import { AiConversation } from './ai-conversation.entity.js';

/**
 * One turn of a conversation. User turns carry the text only; assistant turns also carry the
 * draft, the provider and model that produced it, and token usage.
 */
@Entity('ai_messages')
@Index('IDX_ai_messages_conversationId_createdAt', ['conversationId', 'createdAt'])
@Check('CHK_ai_messages_role', `"role" IN ('user', 'assistant')`)
export class AiMessage {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_ai_messages_id' })
  id: string;

  @Column({ type: 'uuid' })
  conversationId: string;

  @ManyToOne(() => AiConversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId', foreignKeyConstraintName: 'FK_ai_messages_conversationId' })
  conversation?: AiConversation;

  @Column({ type: 'text' })
  role: MessageRole;

  @Column({ type: 'text' })
  text: string;

  @Column({ type: 'jsonb', nullable: true })
  draft: TripDraft | null;

  @Column({ type: 'text', nullable: true })
  provider: string | null;

  @Column({ type: 'text', nullable: true })
  model: string | null;

  @Column({ type: 'integer', nullable: true })
  inputTokens: number | null;

  @Column({ type: 'integer', nullable: true })
  outputTokens: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
