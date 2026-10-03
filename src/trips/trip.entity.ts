import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('trips')
@Index('IDX_trips_provider_chatId', ['provider', 'chatId'])
@Index('IDX_trips_dates', ['startDate', 'endDate'])
@Check('CHK_trips_dates', '"endDate" >= "startDate"')
export class Trip {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_trips_id' })
  id: string;

  @Column({ type: 'text' })
  provider: string;

  // Text, not int: Telegram chat ids can exceed 2^31 and may be negative.
  @Column({ type: 'text' })
  chatId: string;

  @Column({ type: 'varchar', length: 100 })
  destination: string;

  // Postgres `date` columns are hydrated by TypeORM as `YYYY-MM-DD` strings.
  @Column({ type: 'date' })
  startDate: string;

  @Column({ type: 'date' })
  endDate: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
