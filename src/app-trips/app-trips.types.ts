/** App API trip types (`docs/app-api-contract.md`). */

export const TRIP_ROLES = ['owner', 'editor', 'viewer'] as const;
export type TripRole = (typeof TRIP_ROLES)[number];

export const PARTY_TYPES = ['solo', 'couple', 'family', 'friends', 'work'] as const;
export type PartyType = (typeof PARTY_TYPES)[number];

export const MIN_PARTY_SIZE = 1;
export const MAX_PARTY_SIZE = 20;

/** How many members a `Trip` response lists (for avatar stacks). */
export const MEMBER_PREVIEW_SIZE = 5;

export type TravelerProfile = {
  questionSetVersion: number;
  /** questionId -> option ids. */
  answers: Record<string, string[]>;
  /** The `personas` label computed by `WizardService` from the answers' tags, or null. */
  persona: string | null;
};

export type MemberSummary = { userId: string; displayName: string; avatarUrl: string | null; role: TripRole };

/** Contract `Trip` JSON shape of the app API. */
export type AppTripDto = {
  id: string;
  destination: string;
  startDate: string;
  endDate: string;
  notes: string | null;
  story: string | null;
  partyType: PartyType | null;
  partySize: number | null;
  travelerProfile: TravelerProfile | null;
  myRole: TripRole;
  members: MemberSummary[];
  memberCount: number;
  createdAt: string;
  updatedAt: string;
};
