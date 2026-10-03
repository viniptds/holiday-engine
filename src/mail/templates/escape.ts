const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes a value for HTML text or a quoted attribute. Use on every interpolated value. */
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);

// C0 controls, DEL, C1 controls (U+0080–U+009F, including NEL U+0085), LINE and PARAGRAPH SEPARATOR.
const CONTROL_AND_LINE_BREAKS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

/** One clean line: control characters and line breaks become spaces, runs of whitespace collapse. */
export const singleLine = (value: string): string => value.replace(CONTROL_AND_LINE_BREAKS, ' ').replace(/\s+/g, ' ').trim();
