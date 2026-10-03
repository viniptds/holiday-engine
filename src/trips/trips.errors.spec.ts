import { HttpStatus } from '@nestjs/common';
import { TripNotFoundError, TripValidationError } from './trips.errors.js';

describe('trip errors', () => {
  it('TripNotFoundError carries the trip id and a 404 status', () => {
    const error = new TripNotFoundError('abc');

    expect(error.tripId).toBe('abc');
    expect(error.message).toBe('Trip abc not found');
    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
  });

  it('TripValidationError is a 400 with the given message', () => {
    const error = new TripValidationError('endDate must be on or after startDate');

    expect(error.message).toBe('endDate must be on or after startDate');
    expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });
});
