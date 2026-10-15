import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../users/user.entity.js';

export const LEAD_KINDS = ['beta', 'contact'] as const;
export const LEAD_LANGS = ['en', 'pt'] as const;
export const LEAD_STATUSES = ['new', 'invited', 'converted', 'unsubscribed'] as const;
export type LeadKind = (typeof LEAD_KINDS)[number];
export type LeadLang = (typeof LEAD_LANGS)[number];
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type LeadUtm = Partial<Record<'source' | 'medium' | 'campaign' | 'content' | 'term', string>>;

/**
 * An incomplete user (docs/web-leads-spec.md): someone who left a name and email on the landing page
 * and has no account yet. `email` is stored trimmed and lowercased; it is unique through the
 * expression index UQ_leads_email_lower (on lower("email")) created in the migration.
 */
@Entity('leads')
@Check('CHK_leads_kind', `"kind" IN ('beta', 'contact')`)
@Check('CHK_leads_lang', `"lang" IN ('en', 'pt')`)
@Check('CHK_leads_status', `"status" IN ('new', 'invited', 'converted', 'unsubscribed')`)
export class Lead {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_leads_id' })
  id: string;

  @Column({ type: 'varchar', length: 320 })
  email: string;

  @Column({ type: 'varchar', length: 80, nullable: true })
  name: string | null;

  @Column({ type: 'text' })
  kind: LeadKind;

  @Column({ type: 'varchar', length: 80, nullable: true })
  role: string | null;

  @Column({ type: 'text', nullable: true })
  message: string | null;

  @Column({ type: 'text' })
  lang: LeadLang;

  @Column({ type: 'varchar', length: 32 })
  source: string;

  @Column({ type: 'jsonb', nullable: true })
  utm: LeadUtm | null;

  /** SHA-256 of the IP plus LEADS_HASH_SALT; the raw IP is never stored. */
  @Column({ type: 'varchar', length: 64 })
  ipHash: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  userAgent: string | null;

  @Column({ type: 'text', default: 'new' })
  status: LeadStatus;

  @Column({ type: 'uuid', nullable: true })
  convertedUserId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'convertedUserId', foreignKeyConstraintName: 'FK_leads_convertedUserId' })
  convertedUser?: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
