import { SUPPORTED_LOCALES } from '../../app-common/locale.js';
import type { Locale } from '../../app-common/locale.js';
import { INVITE_COPY, renderInviteEmail } from './invite.js';
import type { InviteEmailData } from './invite.js';
import { escapeHtml, singleLine } from './escape.js';
import { formatDateRange } from './format.js';
import { BRAND } from './layout.js';

const TOKEN = 'kq3V9xYzAbCdEfGhIjKlMnOpQrStUvWxYz0123456_-';
const data: InviteEmailData = {
  inviter: 'Ana Silva',
  destination: 'Lisbon',
  startDate: '2026-11-06',
  endDate: '2026-11-15',
  role: 'editor',
  url: `https://holid.ai/invite/${TOKEN}`,
  deepLink: `holidai://invite/${TOKEN}`,
  expiresAt: new Date('2026-10-10T14:00:00.000Z'),
};

const render = (locale: Locale, overrides: Partial<InviteEmailData> = {}) => renderInviteEmail(locale, { ...data, ...overrides });

describe('renderInviteEmail', () => {
  describe.each(SUPPORTED_LOCALES)('%s', (locale) => {
    it('fills every placeholder in subject, text and HTML', () => {
      const email = render(locale);
      const dates = formatDateRange(locale, data.startDate, data.endDate);

      for (const part of [email.subject, email.text, email.html]) {
        expect(part).not.toMatch(/undefined|null|NaN|\$\{|\{\{|\[object/);
      }
      for (const part of [email.text, email.html]) {
        expect(part).toContain('Ana Silva');
        expect(part).toContain('Lisbon');
        expect(part).toContain(dates);
        expect(part).toContain(data.url);
        expect(part).toContain(data.deepLink);
        expect(part).toContain(INVITE_COPY[locale].access.editor);
        expect(part).toContain(INVITE_COPY[locale].button);
      }
      expect(email.html).toContain(`lang="${locale}"`);
    });

    it('escapes every interpolated value in the HTML', () => {
      const email = render(locale, {
        destination: '<b>Rio & "Co"</b>',
        inviter: `<script>alert('x')</script>`,
        url: 'https://holid.ai/invite/a"onmouseover="x',
      });

      expect(email.html).toContain(escapeHtml('<b>Rio & "Co"</b>'));
      expect(email.html).toContain('&lt;b&gt;Rio &amp; &quot;Co&quot;&lt;/b&gt;');
      expect(email.html).not.toContain('<b>Rio');
      expect(email.html).not.toContain('<script>');
      expect(email.html).not.toContain('a"onmouseover');
      // Plain text keeps the raw value.
      expect(email.text).toContain('<b>Rio & "Co"</b>');
    });

    it('uses a fixed subject with no user-controlled text', () => {
      const plain = render(locale);
      const hostile = render(locale, { destination: 'Rio\r\nBcc: x@evil.test', inviter: '\u2028Free money\u0085' });

      expect(hostile.subject).toBe(plain.subject);
      expect(plain.subject).toBe(INVITE_COPY[locale].subject);
      expect(plain.subject).not.toContain('Ana');
      expect(plain.subject).not.toContain('Lisbon');
      expect(hostile.html).toContain(`<title>${escapeHtml(plain.subject)}</title>`);
    });

    it('keeps names on one line in the body, without control characters', () => {
      const { text, html } = render(locale, { destination: 'Rio\nde\u2028Janeiro\u0085!', inviter: 'Ana\u0000\u009b Silva\r\n' });

      expect(text).toContain('Rio de Janeiro !');
      expect(text).toContain('Ana Silva');
      for (const part of [text, html]) expect(part).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/);
    });

    it('stands in a localized traveler for an inviter without a display name, never an email', () => {
      const copy = INVITE_COPY[locale];

      for (const inviter of [null, '', '  \n ']) {
        const { text, html } = render(locale, { inviter });
        expect(text).toContain(copy.intro({ inviter: copy.anonymousInviter.inner, inviterStart: copy.anonymousInviter.start, destination: 'Lisbon' }));
        expect(text).toContain(copy.anonymousInviter.inner);
        expect(html).toContain(escapeHtml(copy.anonymousInviter.start));
        expect(text).not.toContain('@');
      }
    });

    it('describes each role', () => {
      const editor = render(locale, { role: 'editor' });
      const viewer = render(locale, { role: 'viewer' });

      expect(editor.text).toContain(INVITE_COPY[locale].roleLine.editor);
      expect(viewer.text).toContain(INVITE_COPY[locale].roleLine.viewer);
      expect(viewer.text).toContain(INVITE_COPY[locale].access.viewer);
      expect(viewer.text).not.toContain(INVITE_COPY[locale].roleLine.editor);
    });

    it('uses only safe fixed wording (no markup in the copy itself)', () => {
      const copy = INVITE_COPY[locale];
      const v = { inviter: 'X', inviterStart: 'X', destination: 'Y' };
      const fixed = [
        copy.subject, copy.anonymousInviter.inner, copy.anonymousInviter.start, copy.preheader(v), copy.heading(v), copy.intro(v), copy.footer(v), copy.expires('Z'),
        copy.button, copy.appPrefix, copy.appLabel, copy.linkFallback,
        ...Object.values(copy.labels), ...Object.values(copy.access), ...Object.values(copy.roleLine),
      ];
      for (const text of fixed) expect(text).not.toMatch(/[<&]/);
    });
  });

  it.each<[Locale, RegExp, RegExp]>([
    ['en', /Nov 6\s*–\s*15, 2026/, /October 10, 2026/],
    ['pt-BR', /6\s*–\s*15 de nov\. de 2026/, /10 de outubro de 2026/],
    ['es', /6\s*–\s*15 nov 2026/, /10 de octubre de 2026/],
  ])('formats dates and expiry for %s', (locale, dates, expiry) => {
    const { text } = render(locale);

    expect(text).toMatch(dates);
    expect(text).toMatch(expiry);
  });

  it('shows a one-day trip as a single date', () => {
    expect(render('pt-BR', { endDate: '2026-11-06' }).text).toContain('6 de nov. de 2026');
  });

  it.each<Locale>(['pt-BR', 'es'])('leaves no English in %s', (locale) => {
    const strip = (s: string) => s.replace(/https?:\/\/\S+|holidai:\/\/\S+/g, '').replace(/Holid\.ai/g, '');
    const { subject, text, html } = render(locale);
    const visibleHtml = html.replace(/<[^>]+>/g, ' ');
    // English words from the en copy. ("link" is everyday Brazilian Portuguese and "plan" is Spanish, so they're allowed.)
    const english = /\b(invited?|invite|trip|open|dates?|your|you|can|edit|view|valid|until|ignore|already|button|browser|getting|expecting|nothing|destination|access)\b/i;

    for (const part of [subject, text, visibleHtml]) expect(strip(part)).not.toMatch(english);
  });

  it.each([
    ['en', "You're invited to plan a trip on Holid.ai"],
    ['pt-BR', 'Tem um convite de viagem para você no Holid.ai'],
    ['es', 'Tienes una invitación para planear un viaje en Holid.ai'],
  ] as const)('has a fixed %s subject', (locale, subject) => {
    expect(render(locale).subject).toBe(subject);
  });

  it('singleLine removes C0/C1 controls, NEL and the Unicode line separators', () => {
    expect(singleLine('a\u0000b\u001Fc\u007Fd\u0085e\u009Ff\u2028g\u2029h\r\n\ti  j')).toBe('a b c d e f g h i j');
  });

  it('is email-safe HTML: tables, inline styles, 600 px, brand colours, ink text on Sunset', () => {
    const { html } = render('en');

    expect(html).toContain('max-width:600px');
    expect(html).toContain('role="presentation"');
    expect(html).not.toMatch(/<style|<link|<script|class="/);
    expect(html).toContain(BRAND.lagoon);
    expect(html).toMatch(new RegExp(`bgcolor="${BRAND.sunset}"[^>]*>\\s*<a [^>]*color:${BRAND.ink}`));
    expect(html).toContain('name="viewport"');
  });
});
