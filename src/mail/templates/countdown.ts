import type { Locale } from '../../app-common/locale.js';
import type { ChecklistPriority } from '../../checklist/checklist.entities.js';
import { escapeHtml, singleLine } from './escape.js';
import { formatDateRange } from './format.js';
import { BRAND, FONT, button, emailLayout, link, paragraph, smallParagraph } from './layout.js';
import type { RenderedEmail } from './invite.js';

/** What a countdown email shows. Raw values: the template escapes them. */
export type CountdownEmailData = {
  destination: string;
  startDate: string;
  endDate: string;
  /** 30 or 7. */
  daysLeft: number;
  /** Open checklist items, any order (sorted here by priority). */
  items: { title: string; priority: ChecklistPriority }[];
  /** `holidai://trip/<id>/checklist`. */
  appLink: string;
  unsubscribeUrl: string;
};

type CountdownCopy = {
  subject: (days: number) => string;
  heading: (destination: string, days: number) => string;
  intro: (dates: string) => string;
  listTitle: string;
  empty: string;
  priority: Record<ChecklistPriority, string>;
  button: string;
  footer: string;
  unsubscribe: string;
};

/** Fixed subjects (no user text). Glossary: viagem/viaje, checklist → lista de tarefas/lista. */
export const COUNTDOWN_COPY: Record<Locale, CountdownCopy> = {
  en: {
    subject: (days) => (days === 7 ? 'Your trip is one week away' : 'Your trip is one month away'),
    heading: (d, days) => (days === 7 ? `${d} is one week away` : `${d} is one month away`),
    intro: (dates) => `Your trip (${dates}) is coming, be prepared! Here's what's still open on your checklist.`,
    listTitle: 'Still to do',
    empty: 'Everything on your checklist is done. Nice work!',
    priority: { high: 'High', medium: 'Medium', low: 'Low' },
    button: 'Open the checklist',
    footer: "You're getting this because you're on this trip in Holid.ai and countdown emails are on.",
    unsubscribe: 'Stop countdown emails',
  },
  'pt-BR': {
    subject: (days) => (days === 7 ? 'Falta uma semana para a sua viagem' : 'Falta um mês para a sua viagem'),
    heading: (d, days) => (days === 7 ? `Falta uma semana para ${d}` : `Falta um mês para ${d}`),
    intro: (dates) => `Sua viagem (${dates}) está chegando. Prepare-se! Veja o que ainda está em aberto na checklist.`,
    listTitle: 'Ainda falta',
    empty: 'Tudo na checklist está feito. Muito bem!',
    priority: { high: 'Alta', medium: 'Média', low: 'Baixa' },
    button: 'Abrir a checklist',
    footer: 'Você recebeu este e-mail porque está nesta viagem no Holid.ai e os e-mails de contagem regressiva estão ativados.',
    unsubscribe: 'Parar os e-mails de contagem regressiva',
  },
  es: {
    subject: (days) => (days === 7 ? 'Falta una semana para tu viaje' : 'Falta un mes para tu viaje'),
    heading: (d, days) => (days === 7 ? `Falta una semana para ${d}` : `Falta un mes para ${d}`),
    intro: (dates) => `¡Tu viaje (${dates}) se acerca! Prepárate. Esto es lo que aún queda pendiente en tu lista.`,
    listTitle: 'Pendiente',
    empty: 'Todo lo de tu lista está hecho. ¡Bien hecho!',
    priority: { high: 'Alta', medium: 'Media', low: 'Baja' },
    button: 'Abrir la lista',
    footer: 'Recibes este correo porque estás en este viaje en Holid.ai y los correos de cuenta regresiva están activados.',
    unsubscribe: 'Dejar de recibir correos de cuenta regresiva',
  },
};

const ORDER: Record<ChecklistPriority, number> = { high: 0, medium: 1, low: 2 };
const CHIP: Record<ChecklistPriority, string> = { high: BRAND.sunset, medium: '#FFD9A8', low: BRAND.line };

/** The countdown email (subject, text and HTML) in `locale`, open items by priority. */
export function renderCountdownEmail(locale: Locale, data: CountdownEmailData): RenderedEmail {
  const copy = COUNTDOWN_COPY[locale];
  const destination = singleLine(data.destination);
  const dates = formatDateRange(locale, data.startDate, data.endDate);
  const items = [...data.items].sort((a, b) => ORDER[a.priority] - ORDER[b.priority]).map((i) => ({ ...i, title: singleLine(i.title) }));

  const text = [
    copy.heading(destination, data.daysLeft),
    '',
    copy.intro(dates),
    '',
    ...(items.length ? [`${copy.listTitle}:`, ...items.map((i) => `- [${copy.priority[i.priority]}] ${i.title}`)] : [copy.empty]),
    '',
    `${copy.button}: ${data.appLink}`,
    '',
    copy.footer,
    `${copy.unsubscribe}: ${data.unsubscribeUrl}`,
  ].join('\n');

  const rows = items
    .map(
      (i) => `<tr>
      <td style="padding:8px 0;border-bottom:1px solid ${BRAND.line};width:76px;vertical-align:top;"><span style="display:inline-block;padding:2px 10px;border-radius:999px;background-color:${CHIP[i.priority]};font-family:${FONT};font-size:12px;line-height:18px;font-weight:700;color:${BRAND.ink};">${escapeHtml(copy.priority[i.priority])}</span></td>
      <td style="padding:8px 0;border-bottom:1px solid ${BRAND.line};font-family:${FONT};font-size:15px;line-height:20px;color:${BRAND.ink};">${escapeHtml(i.title)}</td>
    </tr>`,
    )
    .join('\n    ');
  const list = items.length
    ? `${paragraph(`<strong>${escapeHtml(copy.listTitle)}</strong>`, 'margin-bottom:4px;')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
    ${rows}
</table>`
    : paragraph(escapeHtml(copy.empty));
  const html = emailLayout({
    lang: locale,
    title: copy.subject(data.daysLeft),
    preheader: copy.intro(dates),
    content: [
      `<h1 style="margin:0 0 12px;font-family:${FONT};font-size:24px;line-height:30px;color:${BRAND.ink};">${escapeHtml(copy.heading(destination, data.daysLeft))}</h1>`,
      paragraph(escapeHtml(copy.intro(dates))),
      list,
      button(copy.button, data.appLink),
    ].join('\n'),
    footer: [smallParagraph(escapeHtml(copy.footer)), smallParagraph(link(copy.unsubscribe, data.unsubscribeUrl))].join('\n'),
  });
  return { subject: copy.subject(data.daysLeft), text, html };
}

/** The small page `GET /email/unsubscribe` shows. */
export const UNSUBSCRIBE_PAGE: Record<Locale, { title: string; done: string; invalid: string }> = {
  en: { title: 'Holid.ai', done: "You won't get countdown emails any more. You can turn them back on in the app's Settings.", invalid: 'This link is invalid.' },
  'pt-BR': { title: 'Holid.ai', done: 'Você não vai mais receber e-mails de contagem regressiva. Dá para ativar de novo nas Configurações do app.', invalid: 'Este link é inválido.' },
  es: { title: 'Holid.ai', done: 'Ya no recibirás correos de cuenta regresiva. Puedes volver a activarlos en los Ajustes de la app.', invalid: 'Este enlace no es válido.' },
};

export function renderUnsubscribePage(locale: Locale, ok: boolean): string {
  const copy = UNSUBSCRIBE_PAGE[locale];
  return emailLayout({ lang: locale, title: copy.title, preheader: '', content: paragraph(escapeHtml(ok ? copy.done : copy.invalid)), footer: '' });
}
