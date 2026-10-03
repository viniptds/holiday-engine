import { Trip } from './trip.entity.js';

/** Contract `Trip` JSON shape (docs/trip-engine-contract.md). */
export type TripDto = {
  id: string;
  destination: string;
  startDate: string;
  endDate: string;
  notes: string | null;
  createdAt: string;
};

export function toTripDto(trip: Trip): TripDto {
  return {
    id: trip.id,
    destination: trip.destination,
    startDate: trip.startDate,
    endDate: trip.endDate,
    notes: trip.notes ?? null,
    createdAt: new Date(trip.createdAt).toISOString(),
  };
}
