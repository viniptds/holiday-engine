import { IsIn } from 'class-validator';
import { TRIP_ROLES } from '../../app-trips/app-trips.types.js';
import type { TripRole } from '../../app-trips/app-trips.types.js';

/** `PATCH /trips/:id/members/:userId` body. `owner` transfers ownership. */
export class UpdateMemberDto {
  @IsIn(TRIP_ROLES)
  role: TripRole;
}
