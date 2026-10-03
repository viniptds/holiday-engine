import { BadRequestException, NotFoundException } from '@nestjs/common';

/** Trip does not exist or belongs to another chat. Maps to contract error `NOT_FOUND`. */
export class TripNotFoundError extends NotFoundException {
  constructor(readonly tripId: string) {
    super(`Trip ${tripId} not found`);
  }
}

/** Business-rule violation detected by the service. Maps to contract error `VALIDATION`. */
export class TripValidationError extends BadRequestException {}
