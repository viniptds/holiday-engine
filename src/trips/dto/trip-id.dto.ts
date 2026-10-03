import { IsUUID } from 'class-validator';

/** `trip.delete` and `events.suggest` payload. */
export class TripIdDto {
  @IsUUID()
  tripId: string;
}
