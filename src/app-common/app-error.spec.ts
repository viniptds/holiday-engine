import { AppError, CONFLICT_REASONS, conflict, forbidden, FORBIDDEN_REASONS, VALIDATION_REASONS } from './app-error.js';
import { toAppErrorBody } from './app-exception.filter.js';

describe('AppError reasons (docs/app-api-contract.md, Errors)', () => {
  it('lists exactly the contract reasons', () => {
    expect([...CONFLICT_REASONS]).toEqual([
      'REPLY_IN_PROGRESS',
      'PLAN_FULL',
      'RETRY_LIMIT',
      'CONVERSATION_CLOSED',
      'DRAFT_NOT_READY',
      'ALREADY_IN_TRIP',
      'TRIP_PLACES_LIMIT',
      'STALE_ITINERARY',
      'LAST_OWNER',
      'ALREADY_MEMBER',
      'TRIP_CHANGED',
      'UNASSIGNED_MOMENTS_LIMIT',
      'UPLOAD_INCOMPLETE',
      'UPLOAD_MISMATCH',
      'MOMENT_DAY_LOCKED',
      'CHECKLIST_FULL',
    ]);
    expect([...FORBIDDEN_REASONS]).toEqual(['REMOVED_FROM_TRIP', 'INVITE_OTHER_ACCOUNT', 'DEV_ACCOUNT_EMAIL_INVITE', 'NOT_CONVERSATION_AUTHOR']);
    expect([...VALIDATION_REASONS]).toEqual(['STEP_NOT_SKIPPABLE']);
  });

  it('puts the reason in the body, next to code and message (and fields)', () => {
    expect(toAppErrorBody(conflict('STALE_ITINERARY', 'Reload', { itineraryVersion: '3' }))).toEqual({
      status: 409,
      body: { code: 'CONFLICT', reason: 'STALE_ITINERARY', message: 'Reload', fields: { itineraryVersion: '3' } },
    });
    expect(toAppErrorBody(forbidden('REMOVED_FROM_TRIP', 'Removed'))).toEqual({
      status: 403,
      body: { code: 'FORBIDDEN', reason: 'REMOVED_FROM_TRIP', message: 'Removed' },
    });
  });

  it('leaves reason out when there is none (e.g. a role check)', () => {
    expect(toAppErrorBody(new AppError('FORBIDDEN', "A trip viewer can't do this")).body).toEqual({
      code: 'FORBIDDEN',
      message: "A trip viewer can't do this",
    });
  });
});
