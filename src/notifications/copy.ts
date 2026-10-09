import type { Locale } from '../app-common/locale.js';

/** "Ana", "Ana and Bruno", "Ana and 2 others" (names already single-line). */
type Actors = (names: string[]) => string;

type Copy = {
  actors: Actors;
  memberJoined: (name: string, destination: string) => { title: string; body: string };
  photos: (actors: string, count: number, destination: string) => { title: string; body: string };
  places: (actors: string, destination: string) => { title: string; body: string };
  achievement: (destination: string | null) => { title: string; body: string };
  inviteAccepted: (name: string, destination: string) => { title: string; body: string };
  inviteReceived: (name: string, destination: string) => { title: string; body: string };
  countdown: (destination: string, days: number) => { title: string; body: string };
  reminder: (item: string) => { title: string; body: string };
  someone: string;
};

/** Notification texts (docs/i18n-glossary.md: viagem/viaje, roteiro/itinerario, convite/invitación). */
export const NOTIFICATION_COPY: Record<Locale, Copy> = {
  en: {
    someone: 'Someone',
    actors: (n) => (n.length <= 1 ? (n[0] ?? 'Someone') : n.length === 2 ? `${n[0]} and ${n[1]}` : `${n[0]} and ${n.length - 1} others`),
    memberJoined: (name, d) => ({ title: d, body: `${name} joined your trip to ${d}.` }),
    photos: (a, count, d) => ({ title: d, body: `${a} added ${count === 1 ? 'a photo' : `${count} photos`}.` }),
    places: (a, d) => ({ title: d, body: `${a} updated the itinerary.` }),
    achievement: (d) => ({ title: 'Achievement unlocked', body: d ? `You earned a new badge on your trip to ${d}.` : 'You earned a new badge.' }),
    inviteAccepted: (name, d) => ({ title: d, body: `${name} accepted your invite.` }),
    inviteReceived: (name, d) => ({ title: 'New trip invite', body: `${name} invited you to plan a trip to ${d}. Check your email to join.` }),
    countdown: (d, days) => ({ title: days === 7 ? `${d} in one week` : `${d} in one month`, body: `Your trip to ${d} is coming, be prepared!` }),
    reminder: (item) => ({ title: 'Checklist reminder', body: `Review: ${item}` }),
  },
  'pt-BR': {
    someone: 'Alguém',
    actors: (n) => (n.length <= 1 ? (n[0] ?? 'Alguém') : n.length === 2 ? `${n[0]} e ${n[1]}` : `${n[0]} e mais ${n.length - 1} pessoas`),
    memberJoined: (name, d) => ({ title: d, body: `${name} entrou na sua viagem para ${d}.` }),
    photos: (a, count, d) => ({ title: d, body: `${a} adicionou ${count === 1 ? 'uma foto' : `${count} fotos`}.` }),
    places: (a, d) => ({ title: d, body: `${a} atualizou o roteiro.` }),
    achievement: (d) => ({ title: 'Conquista desbloqueada', body: d ? `Você ganhou um novo selo na viagem para ${d}.` : 'Você ganhou um novo selo.' }),
    inviteAccepted: (name, d) => ({ title: d, body: `${name} aceitou o seu convite.` }),
    inviteReceived: (name, d) => ({ title: 'Novo convite de viagem', body: `${name} convidou você para planejar uma viagem para ${d}. Veja o seu e-mail para entrar.` }),
    countdown: (d, days) => ({ title: days === 7 ? `${d} em uma semana` : `${d} em um mês`, body: `Sua viagem para ${d} está chegando. Prepare-se!` }),
    reminder: (item) => ({ title: 'Lembrete da checklist', body: `Revisar: ${item}` }),
  },
  es: {
    someone: 'Alguien',
    actors: (n) => (n.length <= 1 ? (n[0] ?? 'Alguien') : n.length === 2 ? `${n[0]} y ${n[1]}` : `${n[0]} y ${n.length - 1} personas más`),
    memberJoined: (name, d) => ({ title: d, body: `${name} se unió a tu viaje a ${d}.` }),
    photos: (a, count, d) => ({ title: d, body: `${a} agregó ${count === 1 ? 'una foto' : `${count} fotos`}.` }),
    places: (a, d) => ({ title: d, body: `${a} actualizó el itinerario.` }),
    achievement: (d) => ({ title: 'Logro desbloqueado', body: d ? `Ganaste una nueva insignia en tu viaje a ${d}.` : 'Ganaste una nueva insignia.' }),
    inviteAccepted: (name, d) => ({ title: d, body: `${name} aceptó tu invitación.` }),
    inviteReceived: (name, d) => ({ title: 'Nueva invitación de viaje', body: `${name} te invitó a planear un viaje a ${d}. Revisa tu correo para unirte.` }),
    countdown: (d, days) => ({ title: days === 7 ? `${d} en una semana` : `${d} en un mes`, body: `¡Tu viaje a ${d} se acerca! Prepárate.` }),
    reminder: (item) => ({ title: 'Recordatorio de la lista', body: `Revisar: ${item}` }),
  },
};
