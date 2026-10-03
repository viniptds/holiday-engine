import { escapeHtml } from './escape.js';

/** Brand palette (email-safe hex). Text on Sunset is ink, never white. */
export const BRAND = {
  lagoon: '#0B7A7F',
  sunset: '#FF7A59',
  ink: '#14232A',
  muted: '#5B6B70',
  page: '#F2F6F6',
  card: '#FFFFFF',
  line: '#E3ECEC',
};

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** A "bulletproof" button: a table cell with the colour, so it renders in Outlook too. Inputs are raw (escaped here). */
export function button(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 4px;">
  <tr>
    <td align="center" bgcolor="${BRAND.sunset}" style="border-radius:999px;background-color:${BRAND.sunset};">
      <a href="${escapeHtml(href)}" target="_blank" style="display:inline-block;padding:14px 32px;font-family:${FONT};font-size:16px;font-weight:700;line-height:20px;color:${BRAND.ink};text-decoration:none;border-radius:999px;">${escapeHtml(label)}</a>
    </td>
  </tr>
</table>`;
}

/** Label/value rows (raw inputs, escaped here). */
export function detailsTable(rows: [string, string][]): string {
  const cells = rows
    .map(
      ([label, value]) => `<tr>
      <td style="padding:10px 0;border-bottom:1px solid ${BRAND.line};font-family:${FONT};font-size:13px;line-height:18px;color:${BRAND.muted};width:38%;vertical-align:top;">${escapeHtml(label)}</td>
      <td style="padding:10px 0;border-bottom:1px solid ${BRAND.line};font-family:${FONT};font-size:15px;line-height:20px;color:${BRAND.ink};font-weight:600;vertical-align:top;">${escapeHtml(value)}</td>
    </tr>`,
    )
    .join('\n    ');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;">
    ${cells}
  </table>`;
}

export const paragraph = (html: string, style = '') =>
  `<p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:24px;color:${BRAND.ink};${style}">${html}</p>`;

export const smallParagraph = (html: string) =>
  `<p style="margin:0 0 12px;font-family:${FONT};font-size:13px;line-height:19px;color:${BRAND.muted};">${html}</p>`;

export const link = (label: string, href: string) =>
  `<a href="${escapeHtml(href)}" target="_blank" style="color:${BRAND.lagoon};text-decoration:underline;">${escapeHtml(label)}</a>`;

/**
 * The shared email shell: a 600 px card on a tinted page, Lagoon header with the brand name,
 * table layout and inline styles only. `content` and `footer` are HTML the caller built safely;
 * `lang`, `title` and `preheader` are raw text.
 */
export function emailLayout(options: { lang: string; title: string; preheader: string; content: string; footer: string }): string {
  return `<!DOCTYPE html>
<html lang="${escapeHtml(options.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(options.title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(options.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.page}" style="background-color:${BRAND.page};">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:${BRAND.card};border-radius:16px;overflow:hidden;">
        <tr>
          <td bgcolor="${BRAND.lagoon}" style="background-color:${BRAND.lagoon};padding:20px 28px;font-family:${FONT};font-size:22px;font-weight:800;line-height:28px;color:#FFFFFF;letter-spacing:0.2px;">Holid.ai</td>
        </tr>
        <tr>
          <td style="padding:28px 28px 8px;">
            ${options.content}
          </td>
        </tr>
        <tr>
          <td style="padding:8px 28px 24px;border-top:1px solid ${BRAND.line};">
            ${options.footer}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

export { FONT };
