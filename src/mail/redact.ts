/** Replaces every link (`https://…`, `holidai://…`) with `[link]`: invite links carry live tokens. */
export const redactLinks = (text: string): string => text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[link]');

/** Replaces each non-empty `secret` (exact text) with `label`. */
export function redactValues(text: string, secrets: [string | null | undefined, string][]): string {
  return secrets.reduce((out, [secret, label]) => (secret ? out.split(secret).join(label) : out), text);
}
