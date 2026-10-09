/** Per-user notification switches (docs/app-notifications-checklist-calendar-spec.md). */
export type NotificationPrefs = {
  push: { countdown: boolean; checklist: boolean; tripActivity: boolean; achievements: boolean; invites: boolean };
  email: { countdown: boolean };
};

export type PushCategory = keyof NotificationPrefs['push'];
export const PUSH_CATEGORIES: PushCategory[] = ['countdown', 'checklist', 'tripActivity', 'achievements', 'invites'];

export const DEFAULT_PREFS: NotificationPrefs = {
  push: { countdown: true, checklist: true, tripActivity: true, achievements: true, invites: true },
  email: { countdown: true },
};

/** The stored prefs with every missing switch on (rows saved before a switch existed, or null). */
export function effectivePrefs(stored: Partial<{ push: Partial<NotificationPrefs['push']>; email: Partial<NotificationPrefs['email']> }> | null | undefined): NotificationPrefs {
  return {
    push: { ...DEFAULT_PREFS.push, ...pickBooleans(stored?.push, PUSH_CATEGORIES) },
    email: { ...DEFAULT_PREFS.email, ...pickBooleans(stored?.email, ['countdown']) },
  };
}

function pickBooleans<K extends string>(value: unknown, keys: readonly K[]): Partial<Record<K, boolean>> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(keys.filter((k) => typeof (value as Record<string, unknown>)[k] === 'boolean').map((k) => [k, (value as Record<K, boolean>)[k]])) as Partial<Record<K, boolean>>;
}

/**
 * Validates a partial PATCH (`{ push?: { … }, email?: { countdown? } }`, booleans only, no unknown
 * keys). Returns the field errors, empty if it's fine.
 */
export function prefsPatchErrors(body: unknown): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { body: 'must be an object' };
  for (const [section, value] of Object.entries(body as Record<string, unknown>)) {
    const allowed = section === 'push' ? PUSH_CATEGORIES : section === 'email' ? ['countdown'] : null;
    if (!allowed) {
      errors[section] = 'unknown setting';
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors[section] = 'must be an object';
      continue;
    }
    for (const [key, flag] of Object.entries(value as Record<string, unknown>)) {
      if (!(allowed as string[]).includes(key)) errors[`${section}.${key}`] = 'unknown setting';
      else if (typeof flag !== 'boolean') errors[`${section}.${key}`] = 'must be true or false';
    }
  }
  return errors;
}

/** `current` with a validated partial patch applied. */
export function applyPrefsPatch(current: NotificationPrefs, patch: { push?: Partial<NotificationPrefs['push']>; email?: Partial<NotificationPrefs['email']> }): NotificationPrefs {
  return { push: { ...current.push, ...(patch.push ?? {}) }, email: { ...current.email, ...(patch.email ?? {}) } };
}
