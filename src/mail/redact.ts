/** Replaces every link (`https://…`, `holidai://…`) with `[link]`: invite links carry live tokens. */
export const redactLinks = (text: string): string => text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[link]');

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replaces each non-empty `secret` with `label`, ignoring case (providers may echo an address upper-cased). */
export function redactValues(text: string, secrets: [string | null | undefined, string][]): string {
  return secrets.reduce(
    (out, [secret, label]) => (secret ? out.replace(new RegExp(escapeRegExp(secret), 'gi'), () => label) : out),
    text,
  );
}

// Anything shaped like an email address (local@domain.tld), in any case.
const EMAIL_LIKE = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi;

/** Replaces anything that looks like an email address with `[email]`. */
export const redactEmails = (text: string): string => text.replace(EMAIL_LIKE, '[email]');

/**
 * Provider error text made safe to log: the given secrets (token, recipient) in any case, then
 * any other email address, then any link.
 */
export const redactProviderError = (text: string, secrets: string[]): string =>
  redactLinks(redactEmails(redactValues(text, secrets.map((secret) => [secret, '[redacted]'] as [string, string]))));
