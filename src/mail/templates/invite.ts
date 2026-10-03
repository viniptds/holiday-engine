import type { Locale } from '../../app-common/locale.js';
import type { InviteRole } from '../../members/members.types.js';
import { escapeHtml, singleLine } from './escape.js';
import { formatDateRange, formatLongDate } from './format.js';
import { BRAND, FONT, button, detailsTable, emailLayout, link, paragraph, smallParagraph } from './layout.js';

/** Everything an invite email shows. Raw values: the templates escape them. */
export type InviteEmailData = {
  /** The inviter's display name; null or blank → the localized "A Holid.ai traveler". Never their email. */
  inviter: string | null;
  destination: string;
  startDate: string;
  endDate: string;
  role: InviteRole;
  url: string;
  deepLink: string;
  expiresAt: Date;
};

export type RenderedEmail = { subject: string; text: string; html: string };

/** `inviterStart` is the form that opens a sentence (it only differs for the anonymous inviter). */
type Names = { inviter: string; inviterStart: string; destination: string };

/**
 * The copy, per locale. Sentences receive the names already prepared for the output: raw for
 * text, escaped and bolded for HTML. The fixed wording itself must not contain `<` or `&`.
 */
type InviteCopy = {
  /** Fixed: no user-controlled text in the subject line. */
  subject: string;
  /** Stands in for an inviter without a display name, mid-sentence and opening a sentence. */
  anonymousInviter: { inner: string; start: string };
  preheader: (v: Names) => string;
  heading: (v: Names) => string;
  intro: (v: Names) => string;
  labels: { destination: string; dates: string; access: string };
  access: Record<InviteRole, string>;
  roleLine: Record<InviteRole, string>;
  button: string;
  appPrefix: string;
  appLabel: string;
  linkFallback: string;
  expires: (date: string) => string;
  footer: (v: Names) => string;
};

export const INVITE_COPY: Record<Locale, InviteCopy> = {
  en: {
    subject: "You're invited to plan a trip on Holid.ai",
    anonymousInviter: { inner: 'a Holid.ai traveler', start: 'A Holid.ai traveler' },
    preheader: (v) => `Join ${v.inviter} in planning ${v.destination} on Holid.ai.`,
    heading: (v) => `You're invited to ${v.destination}`,
    intro: (v) => `${v.inviterStart} is planning a trip to ${v.destination} and would love to have you along.`,
    labels: { destination: 'Destination', dates: 'Dates', access: 'Your access' },
    access: { editor: 'Can edit', viewer: 'Can view' },
    roleLine: {
      editor: "You'll be able to edit the trip and help shape the plan.",
      viewer: "You'll be able to see the plan and follow along as it comes together.",
    },
    button: 'Open invite',
    appPrefix: 'Already have the app?',
    appLabel: 'Open it in Holid.ai',
    linkFallback: "If the button doesn't work, copy this link into your browser:",
    expires: (date) => `This invite is valid until ${date}.`,
    footer: (v) =>
      `You're getting this email because ${v.inviter} invited you to a trip on Holid.ai. Not expecting it? Just ignore it and nothing will happen.`,
  },
  'pt-BR': {
    subject: 'Tem um convite de viagem para você no Holid.ai',
    anonymousInviter: { inner: 'alguém do Holid.ai', start: 'Alguém do Holid.ai' },
    preheader: (v) => `Vem planejar ${v.destination} com ${v.inviter} no Holid.ai.`,
    heading: (v) => `Partiu ${v.destination}?`,
    intro: (v) => `${v.inviterStart} está planejando uma viagem para ${v.destination} e quer muito você junto.`,
    labels: { destination: 'Destino', dates: 'Datas', access: 'Seu acesso' },
    access: { editor: 'Pode editar', viewer: 'Pode visualizar' },
    roleLine: {
      editor: 'Você vai poder editar a viagem e ajudar a montar o roteiro.',
      viewer: 'Você vai poder ver o roteiro e acompanhar tudo de perto.',
    },
    button: 'Abrir convite',
    appPrefix: 'Já tem o app?',
    appLabel: 'Abra no Holid.ai',
    linkFallback: 'Se o botão não funcionar, copie este link e cole no navegador:',
    expires: (date) => `O convite vale até ${date}.`,
    footer: (v) =>
      `Você recebeu este e-mail porque ${v.inviter} te convidou para uma viagem no Holid.ai. Não estava esperando? É só ignorar, nada vai acontecer.`,
  },
  es: {
    subject: 'Tienes una invitación para planear un viaje en Holid.ai',
    anonymousInviter: { inner: 'alguien de Holid.ai', start: 'Alguien de Holid.ai' },
    preheader: (v) => `Organiza ${v.destination} con ${v.inviter} en Holid.ai.`,
    heading: (v) => `¿Te sumas al viaje a ${v.destination}?`,
    intro: (v) => `${v.inviterStart} está planeando un viaje a ${v.destination} y le encantaría que vinieras.`,
    labels: { destination: 'Destino', dates: 'Fechas', access: 'Tu acceso' },
    access: { editor: 'Puedes editar', viewer: 'Puedes ver' },
    roleLine: {
      editor: 'Podrás editar el viaje y ayudar a organizar el plan.',
      viewer: 'Podrás ver el plan y seguir todo de cerca.',
    },
    button: 'Abrir invitación',
    appPrefix: '¿Ya tienes la app?',
    appLabel: 'Ábrela en Holid.ai',
    linkFallback: 'Si el botón no funciona, copia este enlace y pégalo en tu navegador:',
    expires: (date) => `La invitación es válida hasta el ${date}.`,
    footer: (v) =>
      `Te llegó este correo porque ${v.inviter} te invitó a un viaje en Holid.ai. ¿No lo esperabas? Puedes ignorarlo tranquilamente; no pasará nada.`,
  },
};

/** The invite email (subject, plain text and HTML) in the inviter's locale. */
export function renderInviteEmail(locale: Locale, data: InviteEmailData): RenderedEmail {
  const copy = INVITE_COPY[locale];
  const dates = formatDateRange(locale, data.startDate, data.endDate);
  const expires = copy.expires(formatLongDate(locale, data.expiresAt));
  const name = singleLine(data.inviter ?? '');
  const raw: Names = {
    inviter: name || copy.anonymousInviter.inner,
    inviterStart: name || copy.anonymousInviter.start,
    destination: singleLine(data.destination),
  };
  const strong = (value: string) => `<strong style="color:${BRAND.ink};">${escapeHtml(value)}</strong>`;
  const html: Names = { inviter: strong(raw.inviter), inviterStart: strong(raw.inviterStart), destination: strong(raw.destination) };
  const details: [string, string][] = [
    [copy.labels.destination, raw.destination],
    [copy.labels.dates, dates],
    [copy.labels.access, copy.access[data.role]],
  ];

  const text = [
    copy.heading(raw),
    '',
    copy.intro(raw),
    '',
    ...details.map(([label, value]) => `${label}: ${value}`),
    '',
    copy.roleLine[data.role],
    '',
    `${copy.button}: ${data.url}`,
    `${copy.appPrefix} ${copy.appLabel}: ${data.deepLink}`,
    '',
    expires,
    '',
    '--',
    copy.footer(raw),
    '',
  ].join('\n');

  const content = [
    `<h1 style="margin:0 0 16px;font-family:${FONT};font-size:24px;line-height:31px;font-weight:800;color:${BRAND.ink};">${escapeHtml(copy.heading(raw))}</h1>`,
    paragraph(copy.intro(html)),
    detailsTable(details),
    paragraph(escapeHtml(copy.roleLine[data.role])),
    button(copy.button, data.url),
    paragraph(`${escapeHtml(copy.appPrefix)} ${link(copy.appLabel, data.deepLink)}`, 'font-size:14px;line-height:21px;margin-top:12px;'),
    smallParagraph(escapeHtml(expires)),
    smallParagraph(
      `${escapeHtml(copy.linkFallback)}<br><a href="${escapeHtml(data.url)}" target="_blank" style="color:${BRAND.lagoon};word-break:break-all;">${escapeHtml(data.url)}</a>`,
    ),
  ].join('\n            ');

  return {
    subject: copy.subject,
    text,
    html: emailLayout({
      lang: locale,
      title: copy.subject,
      preheader: copy.preheader(raw),
      content,
      footer: smallParagraph(copy.footer(html)),
    }),
  };
}
