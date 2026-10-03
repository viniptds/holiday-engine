import type { AiConversationDto, AiTurnDto, TripPlaceDto } from './ai.types.js';
import type { AiConversation } from './entities/ai-conversation.entity.js';
import type { AiMessage } from './entities/ai-message.entity.js';
import type { TripPlace } from './entities/trip-place.entity.js';

const iso = (date: Date) => new Date(date).toISOString();

export function toConversationDto(conversation: AiConversation): AiConversationDto {
  return {
    id: conversation.id,
    status: conversation.status,
    tripId: conversation.tripId ?? null,
    title: conversation.title ?? null,
    createdAt: iso(conversation.createdAt),
    updatedAt: iso(conversation.updatedAt),
  };
}

export function toTurnDto(message: AiMessage): AiTurnDto {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    draft: message.role === 'assistant' ? (message.draft ?? null) : null,
    createdAt: iso(message.createdAt),
  };
}

export function toTripPlaceDto(place: TripPlace): TripPlaceDto {
  return {
    id: place.id,
    name: place.name,
    category: place.category,
    day: place.day ?? null,
    notes: place.notes ?? null,
    googlePlaceId: place.googlePlaceId,
    address: place.address,
    lat: place.lat,
    lng: place.lng,
    rating: place.rating ?? null,
    mapsUrl: place.mapsUrl ?? null,
    source: place.source,
    createdAt: iso(place.createdAt),
  };
}

/** By day (places without a day last), then by name. */
export function compareTripPlaces(a: TripPlace, b: TripPlace): number {
  const dayA = a.day ?? Number.POSITIVE_INFINITY;
  const dayB = b.day ?? Number.POSITIVE_INFINITY;
  return dayA - dayB || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}
