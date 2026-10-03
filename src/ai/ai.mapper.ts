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
    googlePlaceId: place.googlePlaceId,
    name: place.name,
    address: place.address,
    lat: Number(place.lat),
    lng: Number(place.lng),
    rating: place.rating ?? null,
    mapsUrl: place.mapsUrl ?? null,
    types: place.types ?? [],
    category: place.category,
    day: place.day ?? null,
    position: place.position ?? 0,
    // Postgres `time` comes back as HH:MM:SS.
    startTime: place.startTime ? place.startTime.slice(0, 5) : null,
    notes: place.notes ?? null,
    source: place.source,
    createdAt: iso(place.createdAt),
  };
}

/** The itinerary order: by day (Unplanned last), then position, then creation. */
export function compareTripPlaces(a: TripPlace, b: TripPlace): number {
  const dayA = a.day ?? Number.POSITIVE_INFINITY;
  const dayB = b.day ?? Number.POSITIVE_INFINITY;
  return (
    dayA - dayB ||
    (a.position ?? 0) - (b.position ?? 0) ||
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
    a.id.localeCompare(b.id)
  );
}
