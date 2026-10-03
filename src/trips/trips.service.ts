import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import { Trip } from './trip.entity.js';
import { CreateTripDto } from './dto/create-trip.dto.js';
import { UpdateTripDto } from './dto/update-trip.dto.js';
import { TripNotFoundError, TripValidationError } from './trips.errors.js';
import { TripOwner } from './trips.types.js';
import { daysBetween, MAX_TRIP_DAYS } from './dto/date-rules.js';

// v4, like the ids `gen_random_uuid()` produces.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Trip persistence. Every chat-facing method is scoped by owner (provider + chatId);
 * a trip owned by another chat behaves as if it did not exist.
 * Inputs are expected to be validated with the DTOs first.
 */
@Injectable()
export class TripsService {
  constructor(@InjectRepository(Trip) private readonly trips: Repository<Trip>) {}

  async create(owner: TripOwner, data: CreateTripDto): Promise<Trip> {
    const trip = this.trips.create({
      provider: owner.provider,
      chatId: owner.chatId,
      destination: data.destination,
      startDate: data.startDate,
      endDate: data.endDate,
      notes: data.notes ?? null,
    });
    return this.trips.save(trip);
  }

  listForChat(owner: TripOwner): Promise<Trip[]> {
    return this.trips.find({
      where: { provider: owner.provider, chatId: owner.chatId },
      order: { startDate: 'ASC', createdAt: 'ASC' },
    });
  }

  async getForChat(owner: TripOwner, tripId: string): Promise<Trip> {
    // Non-UUID ids would make Postgres throw; treat them as not found.
    if (!UUID.test(tripId)) throw new TripNotFoundError(tripId);
    const trip = await this.trips.findOneBy({ id: tripId, provider: owner.provider, chatId: owner.chatId });
    if (!trip) throw new TripNotFoundError(tripId);
    return trip;
  }

  async update(owner: TripOwner, data: UpdateTripDto): Promise<Trip> {
    const trip = await this.getForChat(owner, data.tripId);
    if (data.destination !== undefined) trip.destination = data.destination;
    if (data.startDate !== undefined) trip.startDate = data.startDate;
    if (data.endDate !== undefined) trip.endDate = data.endDate;
    if (data.notes !== undefined) trip.notes = data.notes;
    if (trip.endDate < trip.startDate) {
      throw new TripValidationError('endDate must be on or after startDate');
    }
    if (daysBetween(trip.startDate, trip.endDate) > MAX_TRIP_DAYS) {
      throw new TripValidationError(`endDate must be at most ${MAX_TRIP_DAYS} days after startDate`);
    }
    return this.trips.save(trip);
  }

  async delete(owner: TripOwner, tripId: string): Promise<void> {
    const trip = await this.getForChat(owner, tripId);
    await this.trips.remove(trip);
  }

  /** All trips (any chat) in progress on `date` (`YYYY-MM-DD`): startDate <= date <= endDate. */
  findActiveOn(date: string): Promise<Trip[]> {
    return this.trips.find({
      where: { startDate: LessThanOrEqual(date), endDate: MoreThanOrEqual(date) },
      order: { startDate: 'ASC', createdAt: 'ASC' },
    });
  }
}
