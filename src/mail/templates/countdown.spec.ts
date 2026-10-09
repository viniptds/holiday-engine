import { COUNTDOWN_COPY, renderCountdownEmail, renderUnsubscribePage } from './countdown.js';
import { SUPPORTED_LOCALES } from '../../app-common/locale.js';

const data = {
  destination: 'Lisbon <script>',
  startDate: '2026-11-10',
  endDate: '2026-11-15',
  daysLeft: 30,
  items: [
    { title: 'Pack sunscreen', priority: 'low' as const },
    { title: 'Passport & visa', priority: 'high' as const },
    { title: 'Book transfer', priority: 'medium' as const },
  ],
  appLink: 'holidai://trip/abc/checklist',
  unsubscribeUrl: 'https://api.holid.ai/app/v1/email/unsubscribe?token=t.s',
};

describe('countdown email', () => {
  it.each(SUPPORTED_LOCALES)('renders in %s: fixed subject, items by priority, escaped HTML, unsubscribe link', (locale) => {
    const email = renderCountdownEmail(locale, data);
    const copy = COUNTDOWN_COPY[locale];

    expect(email.subject).toBe(copy.subject(30));
    expect(email.subject).not.toContain('Lisbon');
    expect(email.text).toContain(copy.heading('Lisbon <script>', 30));
    expect(email.text.indexOf('Passport & visa')).toBeLessThan(email.text.indexOf('Book transfer'));
    expect(email.text.indexOf('Book transfer')).toBeLessThan(email.text.indexOf('Pack sunscreen'));
    expect(email.text).toContain(`${copy.priority.high}] Passport & visa`);
    expect(email.html).toContain(`lang="${locale}"`);
    expect(email.html).toContain('Passport &amp; visa');
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('href="https://api.holid.ai/app/v1/email/unsubscribe?token=t.s"');
    expect(email.html).toContain(copy.unsubscribe);
    expect(email.text).toContain(data.unsubscribeUrl);
  });

  it('says so when everything is done, and has a 7-day subject', () => {
    const email = renderCountdownEmail('es', { ...data, items: [], daysLeft: 7 });
    expect(email.subject).toBe('Falta una semana para tu viaje');
    expect(email.text).toContain(COUNTDOWN_COPY.es.empty);
  });

  it('renders the unsubscribe page', () => {
    expect(renderUnsubscribePage('en', true)).toContain('get countdown emails any more.');
    expect(renderUnsubscribePage('es', false)).toContain('Este enlace no es válido.');
  });
});
