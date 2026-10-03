export const TELEGRAM_QUEUE = 'telegram';
export const TELEGRAM_JOB = 'telegramJob';

/** Chat platforms the engine accepts (contract: currently only Telegram). */
export const PROVIDERS = ['telegram'];

export const INBOUND_TYPES = ['trip.create', 'trip.list', 'trip.update', 'trip.delete', 'events.suggest'] as const;
export type InboundType = (typeof INBOUND_TYPES)[number];
