import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type HomeCopyVariant = { headline: string; subline: string };

/**
 * AI-refreshed banner copy shared by every user (docs/app-home-spec.md, nightly refresh): the
 * fresh headline/subline pairs for one destination, tier, locale and (bigTrip) angle, served ahead
 * of the curated set until `expiresAt`.
 */
@Entity('home_copy')
@Index('UQ_home_copy_destination_tier_locale_angle', ['destinationId', 'tier', 'locale', 'angle'], { unique: true })
export class HomeCopy {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_home_copy_id' })
  id: string;

  @Column({ type: 'text' })
  destinationId: string;

  @Column({ type: 'text' })
  tier: string;

  @Column({ type: 'text' })
  locale: string;

  /** The bigTrip angle, or '' for the other tiers (part of the unique key, so never null). */
  @Column({ type: 'text', default: '' })
  angle: string;

  @Column({ type: 'jsonb' })
  variants: HomeCopyVariant[];

  @Column({ type: 'text', nullable: true })
  model: string | null;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
