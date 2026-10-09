import type { Locale } from '../app-common/locale.js';

type Titles = Record<'trip_created' | 'first_place' | 'all_days_planned' | 'first_member_joined' | 'checklist_created' | 'trip_finished', string> & {
  day: (n: number) => string;
};

/** Journey node titles (docs/i18n-glossary.md: viagem/viaje, lugar, adicionar/agregar, planejar/planear). */
export const JOURNEY_TITLES: Record<Locale, Titles> = {
  en: {
    trip_created: 'Trip created',
    first_place: 'First place added',
    all_days_planned: 'Every day planned',
    first_member_joined: 'First person joined',
    checklist_created: 'Create your checklist',
    trip_finished: 'Trip finished',
    day: (n) => `Day ${n}`,
  },
  'pt-BR': {
    trip_created: 'Viagem criada',
    first_place: 'Primeiro lugar adicionado',
    all_days_planned: 'Todos os dias planejados',
    first_member_joined: 'Primeira pessoa entrou',
    checklist_created: 'Monte seu checklist',
    trip_finished: 'Viagem concluída',
    day: (n) => `Dia ${n}`,
  },
  es: {
    trip_created: 'Viaje creado',
    first_place: 'Primer lugar agregado',
    all_days_planned: 'Todos los días planeados',
    first_member_joined: 'Se unió la primera persona',
    checklist_created: 'Arma tu lista',
    trip_finished: 'Viaje terminado',
    day: (n) => `Día ${n}`,
  },
};
