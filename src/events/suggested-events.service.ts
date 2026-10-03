import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SuggestedEvent } from './suggested-event.entity.js';

/** Tracks which events were already sent for a trip (table `suggested_events`). */
@Injectable()
export class SuggestedEventsService {
  constructor(@InjectRepository(SuggestedEvent) private readonly suggested: Repository<SuggestedEvent>) {}

  /** The subset of `externalIds` already recorded as sent for the trip. */
  async findSent(tripId: string, externalIds: string[]): Promise<Set<string>> {
    if (externalIds.length === 0) return new Set();
    const rows = await this.suggested.find({
      select: { externalId: true },
      where: { tripId, externalId: In(externalIds) },
    });
    return new Set(rows.map((row) => row.externalId));
  }

  /**
   * Records `externalIds` as sent for the trip and returns the ones that weren't recorded before.
   * A single `INSERT ... ON CONFLICT DO NOTHING RETURNING` keeps this safe if two runs overlap.
   */
  async recordNew(tripId: string, externalIds: string[]): Promise<Set<string>> {
    if (externalIds.length === 0) return new Set();
    const result = await this.suggested
      .createQueryBuilder()
      .insert()
      .into(SuggestedEvent)
      .values(externalIds.map((externalId) => ({ tripId, externalId })))
      .orIgnore()
      .returning(['externalId'])
      .execute();
    const rows = result.raw as { externalId: string }[];
    return new Set(rows.map((row) => row.externalId));
  }
}
