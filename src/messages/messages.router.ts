import { Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { TripsService } from '../trips/trips.service.js';
import { TripNotFoundError, TripValidationError } from '../trips/trips.errors.js';
import { toTripDto } from '../trips/trip.dto.js';
import { CreateTripDto } from '../trips/dto/create-trip.dto.js';
import { UpdateTripDto } from '../trips/dto/update-trip.dto.js';
import { TripIdDto } from '../trips/dto/trip-id.dto.js';
import type { TripOwner } from '../trips/trips.types.js';
import { EventsService } from '../events/events.service.js';
import { OutboundPublisher } from '../outbound/outbound.publisher.js';
import type { ErrorCode, OutboundPayloads, OutboundType } from '../outbound/outbound.types.js';
import type { InboundType } from './messages.constants.js';

/** An inbound job as queued by `MessagesService` (the envelope was validated by the controller). */
export type InboundMessage = {
  type: InboundType;
  provider: string;
  chatId: string;
  correlationId: string;
  payload: Record<string, unknown>;
};

type Reply = { [K in OutboundType]: { type: K; payload: OutboundPayloads[K] } }[OutboundType];

/** Invalid payload for the message type. Maps to contract error `VALIDATION`. */
export class PayloadValidationError extends Error {}

function describeErrors(errors: ValidationError[]): string {
  return errors.flatMap((error) => Object.values(error.constraints ?? {})).join('; ');
}

async function validatePayload<T extends object>(dto: new () => T, payload: unknown): Promise<T> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new PayloadValidationError('payload must be an object');
  }
  const instance = plainToInstance(dto, payload);
  // `whitelist` drops fields the DTO doesn't declare, so they never reach the service.
  const errors = await validate(instance, { whitelist: true });
  if (errors.length > 0) throw new PayloadValidationError(describeErrors(errors));
  return instance;
}

/**
 * Handles one inbound message and publishes exactly one reply on `bot-outbound`: the result,
 * or an `error`. Handler failures never throw, so the queue job doesn't fail or retry.
 */
@Injectable()
export class MessagesRouter {
  private readonly logger = new Logger(MessagesRouter.name);

  constructor(
    private readonly trips: TripsService,
    private readonly events: EventsService,
    private readonly outbound: OutboundPublisher,
  ) {}

  async route(message: InboundMessage): Promise<void> {
    let reply: Reply;
    try {
      reply = await this.handle(message);
    } catch (error) {
      reply = { type: 'error', payload: this.toErrorPayload(error, message) };
    }
    await this.outbound.publish(message, reply.type, reply.payload as never);
  }

  private async handle(message: InboundMessage): Promise<Reply> {
    const owner: TripOwner = { provider: message.provider, chatId: message.chatId };

    switch (message.type) {
      case 'trip.create': {
        const data = await validatePayload(CreateTripDto, message.payload);
        const trip = await this.trips.create(owner, data);
        return { type: 'trip.created', payload: { trip: toTripDto(trip) } };
      }
      case 'trip.list': {
        const trips = await this.trips.listForChat(owner);
        return { type: 'trip.list', payload: { trips: trips.map(toTripDto) } };
      }
      case 'trip.update': {
        const data = await validatePayload(UpdateTripDto, message.payload);
        const trip = await this.trips.update(owner, data);
        return { type: 'trip.updated', payload: { trip: toTripDto(trip) } };
      }
      case 'trip.delete': {
        const { tripId } = await validatePayload(TripIdDto, message.payload);
        await this.trips.delete(owner, tripId);
        return { type: 'trip.deleted', payload: { tripId } };
      }
      case 'events.suggest': {
        const { tripId } = await validatePayload(TripIdDto, message.payload);
        const trip = await this.trips.getForChat(owner, tripId);
        const events = await this.events.suggestForRequest(trip, new Date());
        return { type: 'events.suggestions', payload: { trip: toTripDto(trip), events, trigger: 'request' } };
      }
      default:
        throw new PayloadValidationError(`Unknown message type "${String(message.type)}"`);
    }
  }

  private toErrorPayload(error: unknown, message: InboundMessage): OutboundPayloads['error'] {
    const requestType = String(message.type);
    const fail = (code: ErrorCode, text: string) => ({ code, message: text, requestType });

    if (error instanceof PayloadValidationError || error instanceof TripValidationError) {
      return fail('VALIDATION', error.message);
    }
    if (error instanceof TripNotFoundError) return fail('NOT_FOUND', error.message);

    this.logger.error(
      `Failed to handle ${requestType} (correlationId ${message.correlationId})`,
      error instanceof Error ? error.stack : String(error),
    );
    return fail('INTERNAL', 'Something went wrong while handling the request');
  }
}
