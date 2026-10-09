import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { Trip } from '../trips/trip.entity.js';
import { DestinationCatalog } from './catalog.js';
import { DESTINATION_CATALOG, TRENDING_BUCKETS, TRENDING_MIN_USERS, TRENDING_TTL_MS, TRENDING_WINDOW_DAYS } from './home.types.js';
import type { Destination } from './home.types.js';

export type TrendingEntry = { destination: Destination; users: number; bucket: `${number}+` };

/** `17` → `10+`. */
export function bucketOf(users: number): `${number}+` {
  for (const floor of TRENDING_BUCKETS) if (users >= floor) return `${floor}+`;
  return `${TRENDING_MIN_USERS}+`;
}

/**
 * Trending destinations (docs/app-explore-spec.md, anonymous): catalog destinations with trips
 * created by at least 5 distinct users in the last 30 days, counted in buckets. No user, trip or
 * chat detail leaves this service. Computed at most once an hour, per process.
 */
@Injectable()
export class TrendingService {
  private cached: { until: number; entries: TrendingEntry[] } | null = null;
  /** Tests override this. */
  now: () => Date = () => new Date();

  constructor(
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @Inject(DESTINATION_CATALOG) private readonly catalog: DestinationCatalog,
  ) {}

  reset(): void {
    this.cached = null;
  }

  /** Most users first; ties by catalog popularity, then id. */
  async list(): Promise<TrendingEntry[]> {
    const now = this.now().getTime();
    if (this.cached && this.cached.until > now) return this.cached.entries;
    const since = new Date(now - TRENDING_WINDOW_DAYS * 86_400_000);
    const rows = await this.trips.find({ where: { createdAt: MoreThan(since) } });
    const users = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!row.ownerUserId) continue;
      const destination = this.catalog.match(row.destination);
      if (!destination) continue;
      let set = users.get(destination.id);
      if (!set) users.set(destination.id, (set = new Set()));
      set.add(row.ownerUserId);
    }
    const entries = [...users.entries()]
      .filter(([, set]) => set.size >= TRENDING_MIN_USERS)
      .map(([id, set]) => ({ destination: this.catalog.get(id)!, users: set.size, bucket: bucketOf(set.size) }))
      .sort((a, b) => b.users - a.users || b.destination.popularity - a.destination.popularity || a.destination.id.localeCompare(b.destination.id));
    this.cached = { until: now + TRENDING_TTL_MS, entries };
    return entries;
  }
}
