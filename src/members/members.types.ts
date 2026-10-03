import type { MemberSummary } from '../app-trips/app-trips.types.js';

/** App API member and invite types (`docs/app-api-contract.md`). */

export const INVITE_ROLES = ['editor', 'viewer'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export const DEFAULT_INVITE_ROLE: InviteRole = 'editor';
export const INVITE_TTL_DAYS = 7;
export const DEFAULT_INVITE_BASE_URL = 'https://holid.ai';
export const INVITE_DEEP_LINK_BASE = 'holidai://invite/';

export type MemberDto = MemberSummary & { joinedAt: string };

export type InviteDto = {
  id: string;
  url: string;
  deepLink: string;
  email: string | null;
  role: InviteRole;
  expiresAt: string;
};

export type InvitePreviewDto = {
  destination: string;
  startDate: string;
  endDate: string;
  invitedBy: string;
  role: InviteRole;
  expiresAt: string;
};
