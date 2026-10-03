/** App API types for AI trip planning (`docs/app-ai-spec.md`). */
import type { PartyType } from '../app-trips/app-trips.types.js';

export const CONVERSATION_STATUSES = ['open', 'confirmed', 'abandoned'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_ROLES = ['user', 'assistant'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const PLACE_CATEGORIES = ['food', 'sight', 'nature', 'nightlife', 'shopping', 'activity', 'stay', 'other'] as const;
export type PlaceCategory = (typeof PLACE_CATEGORIES)[number];

export const PLACE_SOURCES = ['ai', 'user'] as const;
export type PlaceSource = (typeof PLACE_SOURCES)[number];

/** Limits from the spec. */
export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_USER_MESSAGES_PER_CONVERSATION = 40;
export const MAX_DRAFT_PLACES = 15;
export const MAX_DRAFT_QUESTIONS = 3;
export const MAX_LISTED_CONVERSATIONS = 50;
export const RATE_LIMITS = [
  { windowMs: 60 * 60 * 1000, max: 30 },
  { windowMs: 24 * 60 * 60 * 1000, max: 150 },
] as const;

/** A Google Places match for a draft place. */
export type VerifiedPlace = {
  googlePlaceId: string;
  address: string;
  lat: number;
  lng: number;
  rating: number | null;
  types: string[];
  mapsUrl: string | null;
};

export type DraftPlace = {
  name: string;
  category: PlaceCategory;
  day: number | null;
  why: string;
  /** false → shown greyed out, never ingested. */
  verified: boolean;
  place: VerifiedPlace | null;
};

export type TripDraft = {
  /** Destination and both dates known and valid. */
  ready: boolean;
  destination: string | null;
  startDate: string | null;
  endDate: string | null;
  partyType: PartyType | null;
  partySize: number | null;
  story: string | null;
  places: DraftPlace[];
  /** What the AI still needs, in the request language. */
  questions: string[];
};

export type AiConversationDto = {
  id: string;
  status: ConversationStatus;
  tripId: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AiTurnDto = { id: string; role: MessageRole; text: string; draft: TripDraft | null; createdAt: string };

export type TripPlaceDto = {
  id: string;
  name: string;
  category: PlaceCategory;
  day: number | null;
  notes: string | null;
  googlePlaceId: string;
  address: string;
  lat: number;
  lng: number;
  rating: number | null;
  mapsUrl: string | null;
  source: PlaceSource;
  createdAt: string;
};
