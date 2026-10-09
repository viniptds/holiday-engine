import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { MAIL_TRANSPORT } from '../mail/mail.types.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { Trip } from '../trips/trip.entity.js';
import { User } from '../users/user.entity.js';
import { UserDeletionHooks } from '../users/user-deletion-hooks.js';
import { ChecklistItem } from '../checklist/checklist.entities.js';
import { Moment } from '../moments/moment.entity.js';
import { MemoryObjectStorage } from '../moments/testing/moments-testing.js';
import { bootMoments, EDITOR, OTHER, OWNER, VIEWER } from '../moments/testing/harness.js';
import type { Harness } from '../moments/testing/harness.js';
import type { CreatedMomentDto } from '../moments/moments.types.js';
import { Notification, NotificationJob, PushTicket, PushToken } from './entities.js';
import { NotificationsService } from './notifications.service.js';
import type { NotificationDto } from './notifications.service.js';
import { PUSH_PROVIDER } from './push/push-provider.js';
import { FakeMail, FakePush, expoToken } from './testing/fakes.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T = { owner: expoToken('owner'), editor: expoToken('editor'), viewer: expoToken('viewer'), other: expoToken('other') };

describe('Notifications (feature)', () => {
  const push = new FakePush();
  const mail = new FakeMail();
  const storage = new MemoryObjectStorage();
  let h: Harness;
  let service: NotificationsService;

  beforeAll(async () => {
    h = await bootMoments({
      storage,
      config: { ENGINE_PUBLIC_URL: 'https://api.holid.test' },
      customize: (b) => b.overrideProvider(PUSH_PROVIDER).useValue(push).overrideProvider(MAIL_TRANSPORT).useValue(mail),
    });
    service = h.moduleRef.get(NotificationsService);
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    h.db.clear();
    h.seedUsers();
    push.reset();
    mail.sent = [];
    storage.reset();
    // The achievement push throttle is in memory, per process.
    (service as unknown as { lastAchievementPush: Map<string, number> }).lastAchievementPush.clear();
    for (const level of ['log', 'warn', 'debug'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    for (const [user, token] of [[OWNER, T.owner], [EDITOR, T.editor], [VIEWER, T.viewer], [OTHER, T.other]]) h.db.seed(PushToken, { token, userId: user, platform: 'ios' });
  });

  afterEach(() => jest.restoreAllMocks());

  const inbox = (userId: string) => h.db.all(Notification, { userId });
  const types = (userId: string) => inbox(userId).map((n) => n.type).filter((t) => t !== 'achievement').sort();

  async function photo(user: string, tripId: string) {
    const created = await h.json<CreatedMomentDto>('POST', '/moments', user, { tripId, contentType: 'image/jpeg', byteSize: 5, width: 1, height: 1, takenAt: new Date().toISOString() });
    storage.put(h.db.all(Moment, { id: created.body.moment.id })[0].objectKey, 5);
    expect((await h.json('POST', `/moments/${created.body.moment.id}/complete`, user)).status).toBe(200);
  }

  describe('push tokens and settings', () => {
    it('upserts a token (moving it to whoever registers it last) and deletes it on sign-out', async () => {
      const token = expoToken('new-device');
      expect((await h.call('POST', '/me/push-tokens', OWNER, { token, platform: 'android', deviceId: 'pixel' })).status).toBe(204);
      expect((await h.call('POST', '/me/push-tokens', EDITOR, { token, platform: 'android', deviceId: 'pixel' })).status).toBe(204);
      expect(h.db.all(PushToken, { token })).toEqual([expect.objectContaining({ userId: EDITOR, platform: 'android', deviceId: 'pixel' })]);

      expect((await h.call('DELETE', `/me/push-tokens/${encodeURIComponent(token)}`, OWNER)).status).toBe(204);
      expect(h.db.all(PushToken, { token })).toHaveLength(1);
      expect((await h.call('DELETE', `/me/push-tokens/${encodeURIComponent(token)}`, EDITOR)).status).toBe(204);
      expect(h.db.all(PushToken, { token })).toEqual([]);
    });

    it.each([
      [{ token: 'not-a-token', platform: 'ios' }],
      [{ token: expoToken('x'), platform: 'symbian' }],
    ])('refuses %j', async (body) => {
      expect((await h.call('POST', '/me/push-tokens', OWNER, body)).status).toBe(400);
    });

    it('defaults every switch on and accepts partial changes', async () => {
      expect((await h.json('GET', '/me/notification-settings', OWNER)).body).toEqual({
        push: { countdown: true, checklist: true, tripActivity: true, achievements: true, invites: true },
        email: { countdown: true },
      });
      const patched = await h.json('PATCH', '/me/notification-settings', OWNER, { push: { tripActivity: false } });
      expect(patched.body).toMatchObject({ push: { tripActivity: false, invites: true }, email: { countdown: true } });
      expect((await h.json('PATCH', '/me/notification-settings', OWNER, { email: { countdown: false } })).body).toMatchObject({ push: { tripActivity: false }, email: { countdown: false } });
      for (const bad of [{ push: { tripActivity: 'no' } }, { push: { sms: true } }, { sms: {} }, []]) {
        expect((await h.json('PATCH', '/me/notification-settings', OWNER, bad)).status).toBe(400);
      }
    });
  });

  describe('trip activity', () => {
    it('tells the other members someone joined, never the person who joined', async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [VIEWER, 'viewer']]);
      const invite = await h.json<{ url: string }>('POST', `/trips/${trip.id}/invites`, OWNER, { role: 'editor' });

      await h.json('POST', `/invites/${invite.body.url.split('/').pop()}/accept`, EDITOR);

      expect(types(OWNER)).toContain('trip.member_joined');
      expect(types(VIEWER)).toContain('trip.member_joined');
      expect(types(EDITOR)).not.toContain('trip.member_joined');
      expect(push.to(T.owner)).toContain('Traveler 2222 joined your trip to Lisbon.');
      expect(push.to(T.editor).some((b) => b.includes('joined'))).toBe(false);
    });

    it('writes the inbox even when the push switch is off', async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor']]);
      await h.json('PATCH', '/me/notification-settings', OWNER, { push: { tripActivity: false } });

      await photo(EDITOR, trip.id);

      expect(types(OWNER)).toContain('trip.photos');
      expect(push.to(T.owner).some((b) => b.includes('photo'))).toBe(false);
    });

    it('combines photos by others into at most one notification an hour per trip and recipient', async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor'], [VIEWER, 'viewer']]);

      await photo(EDITOR, trip.id);
      await photo(EDITOR, trip.id);
      await photo(VIEWER, trip.id);

      // The first went out at once; the next two wait for the hour.
      expect(push.to(T.owner)).toEqual(['Traveler 2222 added a photo.']);
      expect(inbox(OWNER).filter((n) => n.type === 'trip.photos')).toHaveLength(1);
      expect(push.to(T.editor).filter((b) => b.includes('photo'))).toEqual(['Traveler 3333 added a photo.']);
      const pending = h.db.all(NotificationJob, { userId: OWNER, type: 'trip.photos', status: 'pending' });
      expect(pending).toHaveLength(1);
      expect(pending[0].payload).toEqual({ count: 2, actorIds: [EDITOR, VIEWER] });

      await service.run(new Date(Date.now() + 30 * MIN));
      expect(push.to(T.owner)).toHaveLength(1);
      await service.run(new Date(Date.now() + 61 * MIN));
      expect(push.to(T.owner)).toEqual(['Traveler 2222 added a photo.', 'Traveler 2222 and Traveler 3333 added 2 photos.']);
      // Sent once.
      await service.run(new Date(Date.now() + 62 * MIN));
      expect(push.to(T.owner)).toHaveLength(2);
    });

    it('combines place changes the same way, in the recipient\'s language, and never tells the author', async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor']]);
      await h.db.repository(User).update({ id: OWNER }, { locale: 'pt-BR' });

      for (let i = 0; i < 3; i++) await h.json('POST', `/trips/${trip.id}/places`, EDITOR, { googlePlaceId: `mock-place-${i}` });

      expect(push.to(T.owner)).toEqual(['Traveler 2222 atualizou o roteiro.']);
      expect(push.to(T.editor).some((b) => b.includes('itinerary') || b.includes('roteiro'))).toBe(false);
      await service.run(new Date(Date.now() + 2 * HOUR));
      expect(push.to(T.owner)).toHaveLength(2);
    });

    it('stays quiet when a photo only changes day', async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor']], { startDate: '2026-03-10', endDate: '2026-03-12' });
      const created = await h.json<CreatedMomentDto>('POST', '/moments', EDITOR, { tripId: trip.id, source: 'upload', day: 1, contentType: 'image/jpeg', byteSize: 5, width: 1, height: 1, takenAt: new Date().toISOString() });
      storage.put(h.db.all(Moment)[0].objectKey, 5);
      await h.json('POST', `/moments/${created.body.moment.id}/complete`, EDITOR);
      await service.run(new Date(Date.now() + 2 * HOUR));
      const before = types(OWNER).length;

      await h.json('PATCH', `/moments/${created.body.moment.id}`, EDITOR, { day: 2 });
      await service.run(new Date(Date.now() + 4 * HOUR));

      expect(types(OWNER)).toHaveLength(before);
    });
  });

  describe('invites and achievements', () => {
    it('tells an existing account it was invited by email, and the inviter when it accepts', async () => {
      const trip = h.seedTrip([[OWNER, 'owner']]);

      const invite = await h.json<{ url: string }>('POST', `/trips/${trip.id}/invites`, OWNER, { email: '2222@example.com' });
      expect(types(EDITOR)).toEqual(['invite.received']);
      expect(inbox(EDITOR)[0]).toMatchObject({ body: 'Traveler 1111 invited you to plan a trip to Lisbon. Check your email to join.' });
      expect(JSON.stringify(inbox(EDITOR)[0].data)).not.toContain(invite.body.url.split('/').pop());

      await h.json('POST', `/invites/${invite.body.url.split('/').pop()}/accept`, EDITOR);
      expect(types(OWNER)).toContain('invite.accepted');
    });

    it('does not tell the inviter about link invites', async () => {
      const trip = h.seedTrip([[OWNER, 'owner']]);
      const invite = await h.json<{ url: string }>('POST', `/trips/${trip.id}/invites`, OWNER, {});

      await h.json('POST', `/invites/${invite.body.url.split('/').pop()}/accept`, EDITOR);

      expect(types(OWNER)).not.toContain('invite.accepted');
      expect(types(OWNER)).toContain('trip.member_joined');
    });

    it('pushes at most one achievement a minute (several unlocked at once), with every one in the inbox', async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor']], { startDate: '2026-01-10', endDate: '2026-01-11' });

      await h.json('GET', '/me/achievements', OWNER);

      expect(inbox(OWNER).filter((n) => n.type === 'achievement').length).toBeGreaterThan(2);
      expect(push.to(T.owner, 'achievement')).toHaveLength(1);
      void trip;
    });

    it('notifies an unlocked achievement (push with the deep link)', async () => {
      const res = await h.json<{ id: string }>('POST', '/trips', OWNER, { destination: 'Lisbon', startDate: '2027-05-01', endDate: '2027-05-02' });

      const row = inbox(OWNER).find((n) => n.type === 'achievement')!;
      expect(row.data).toMatchObject({ route: `/trip/${res.body.id}/journey`, key: 'trip_created' });
      expect(push.sent.find((m) => m.data.type === 'achievement')?.title).toBe('Achievement unlocked');
    });
  });

  describe('countdowns', () => {
    const NOW = new Date('2026-10-01T00:00:00Z');

    it("plans 30- and 7-day jobs at 09:00 in each member's time zone, idempotently", async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor']], { startDate: '2026-11-10', endDate: '2026-11-15' });
      await h.db.repository(User).update({ id: OWNER }, { timezone: 'America/Sao_Paulo' });
      await h.db.repository(User).update({ id: EDITOR }, { timezone: 'Asia/Tokyo' });

      await service.planCountdowns(NOW);
      await service.planCountdowns(NOW);

      const due = (user: string) => h.db.all(NotificationJob, { userId: user, type: 'countdown', tripId: trip.id }).map((j) => [j.itemId, new Date(j.dueAt).toISOString()]).sort();
      expect(due(OWNER)).toEqual([
        ['30', '2026-10-11T12:00:00.000Z'],
        ['7', '2026-11-03T12:00:00.000Z'],
      ]);
      expect(due(EDITOR)).toEqual([
        ['30', '2026-10-11T00:00:00.000Z'],
        ['7', '2026-11-03T00:00:00.000Z'],
      ]);
    });

    it('uses the right local hour across a DST change (Madrid: CEST in October, CET in November)', async () => {
      const trip = h.seedTrip([[OWNER, 'owner']], { startDate: '2026-11-10', endDate: '2026-11-11' });
      await h.db.repository(User).update({ id: OWNER }, { timezone: 'Europe/Madrid' });

      await service.planCountdowns(NOW);

      expect(h.db.all(NotificationJob, { tripId: trip.id }).map((j) => new Date(j.dueAt).toISOString()).sort()).toEqual(['2026-10-11T07:00:00.000Z', '2026-11-03T08:00:00.000Z']);
    });

    it('sends the push to every member and an email with open checklist items by priority, once', async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor']], { startDate: '2026-11-10', endDate: '2026-11-15' });
      await h.db.repository(User).update({ id: EDITOR }, { notificationPrefs: { push: { countdown: true }, email: { countdown: false } } as never });
      h.db.seed(ChecklistItem, { tripId: trip.id, title: 'Pack sunscreen', priority: 'low', category: 'packing', position: 0 });
      h.db.seed(ChecklistItem, { tripId: trip.id, title: 'Passport <valid>', priority: 'high', category: 'documents', position: 1 });
      h.db.seed(ChecklistItem, { tripId: trip.id, title: 'Done already', priority: 'high', category: 'other', position: 2, done: true });
      await service.planCountdowns(NOW);

      await service.run(new Date('2026-10-11T09:00:00Z'));
      await service.run(new Date('2026-10-11T09:05:00Z'));

      expect(push.to(T.owner)).toEqual(['Your trip to Lisbon is coming, be prepared!']);
      expect(push.to(T.editor)).toEqual(['Your trip to Lisbon is coming, be prepared!']);
      expect(mail.sent).toHaveLength(1);
      const [email] = mail.sent;
      expect(email).toMatchObject({ to: '1111@example.com', subject: 'Your trip is one month away', tags: ['countdown'] });
      expect(email.text.indexOf('Passport <valid>')).toBeLessThan(email.text.indexOf('Pack sunscreen'));
      expect(email.text).not.toContain('Done already');
      expect(email.html).toContain('Passport &lt;valid&gt;');
      expect(email.text).toContain('https://api.holid.test/app/v1/email/unsubscribe?token=');
      expect(email.idempotencyKey).toMatch(/^countdown\//);
    });

    it('re-plans when the trip dates change, and skips members who left', async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor']], { startDate: isoIn(40), endDate: isoIn(42) });
      await service.planCountdowns();
      const before = h.db.all(NotificationJob, { tripId: trip.id, userId: OWNER }).map((j) => new Date(j.dueAt).toISOString()).sort();

      expect((await h.json('PATCH', `/trips/${trip.id}`, OWNER, { startDate: isoIn(35), endDate: isoIn(36) })).status).toBe(200);

      const after = h.db.all(NotificationJob, { tripId: trip.id, userId: OWNER }).map((j) => new Date(j.dueAt).toISOString()).sort();
      expect(after).toHaveLength(2);
      expect(after).not.toEqual(before);
      expect(after[0].slice(0, 10)).toBe(isoIn(5));

      await h.db.repository(TripMember).delete({ tripId: trip.id, userId: EDITOR });
      await service.run(new Date(Date.now() + 6 * DAY));
      expect(push.to(T.owner)).toEqual(['Your trip to Lisbon is coming, be prepared!']);
      expect(push.to(T.editor)).toEqual([]);
      expect(h.db.all(NotificationJob, { userId: EDITOR, type: 'countdown' }).map((j) => j.status)).toContain('skipped');
    });

    it('does not plan a countdown missed long ago', async () => {
      const trip = h.seedTrip([[OWNER, 'owner']], { startDate: isoIn(20), endDate: isoIn(21) });
      await service.planCountdowns();
      expect(h.db.all(NotificationJob, { tripId: trip.id }).map((j) => j.itemId)).toEqual(['7']);
    });
  });

  describe('push receipts', () => {
    it('deletes a token Expo refuses as DeviceNotRegistered, at send or in a receipt 15 minutes later', async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor'], [VIEWER, 'viewer']]);
      push.refuse.set(T.viewer, 'DeviceNotRegistered');

      await photo(EDITOR, trip.id);

      expect(h.db.all(PushToken, { token: T.viewer })).toEqual([]);
      const ticket = h.db.all(PushTicket, { token: T.owner })[0];
      push.receiptsById.set(ticket.id, { status: 'error', error: 'DeviceNotRegistered' });
      await service.checkReceipts(new Date(Date.now() + 5 * MIN));
      expect(h.db.all(PushToken, { token: T.owner })).toHaveLength(1);
      await service.checkReceipts(new Date(Date.now() + 16 * MIN));
      expect(h.db.all(PushToken, { token: T.owner })).toEqual([]);
      expect(h.db.all(PushTicket, { id: ticket.id })).toEqual([]);
    });
  });

  describe('inbox', () => {
    it('lists the last 30 days newest first in pages of 30, marks read, and counts unread on /me', async () => {
      for (let i = 0; i < 35; i++) h.db.seed(Notification, { userId: OWNER, type: 't', title: 'x', body: `n${i}`, data: {}, createdAt: new Date(Date.now() - i * MIN) });
      h.db.seed(Notification, { userId: OWNER, type: 't', title: 'x', body: 'old', data: {}, createdAt: new Date(Date.now() - 31 * DAY) });
      h.db.seed(Notification, { userId: EDITOR, type: 't', title: 'x', body: 'theirs', data: {}, createdAt: new Date() });

      const first = await h.json<{ notifications: NotificationDto[]; nextCursor: string }>('GET', '/me/notifications', OWNER);
      expect(first.body.notifications).toHaveLength(30);
      expect(first.body.notifications[0].body).toBe('n0');
      const second = await h.json<{ notifications: NotificationDto[]; nextCursor: string | null }>('GET', `/me/notifications?before=${encodeURIComponent(first.body.nextCursor)}`, OWNER);
      expect(second.body.notifications.map((n) => n.body)).toEqual(['n30', 'n31', 'n32', 'n33', 'n34']);
      expect(second.body.nextCursor).toBeNull();
      expect((await h.json<{ unreadNotifications: number }>('GET', '/me', OWNER)).body.unreadNotifications).toBe(35);

      await h.call('POST', '/me/notifications/read', OWNER, { ids: [first.body.notifications[0].id] });
      expect((await h.json<{ unreadNotifications: number }>('GET', '/me', OWNER)).body.unreadNotifications).toBe(34);
      await h.call('POST', '/me/notifications/read', OWNER, { all: true });
      expect((await h.json<{ unreadNotifications: number }>('GET', '/me', OWNER)).body.unreadNotifications).toBe(0);
      expect(h.db.all(Notification, { userId: EDITOR })[0].readAt).toBeNull();
      expect((await h.json('GET', '/me/notifications?before=yesterday', OWNER)).status).toBe(400);
    });
  });

  describe('unsubscribe and account deletion', () => {
    it('turns countdown emails off from a signed link, with a localized page; a bad token changes nothing', async () => {
      const url = new URL(service.unsubscribeUrl(OWNER));

      const page = await fetch(`${h.baseUrl}/email/unsubscribe${url.search}`, { headers: { 'accept-language': 'pt-BR' } });
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(await page.text()).toContain('Você não vai mais receber e-mails de contagem regressiva');
      expect((await h.json('GET', '/me/notification-settings', OWNER)).body).toMatchObject({ email: { countdown: false }, push: { countdown: true } });

      const forged = url.searchParams.get('token')!.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
      expect((await fetch(`${h.baseUrl}/email/unsubscribe?token=${forged}`)).status).toBe(400);
      expect((await fetch(`${h.baseUrl}/email/unsubscribe`)).status).toBe(400);
    });

    it('sends nothing to deleted accounts, and removes their tokens and inbox', async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor']]);
      h.db.seed(Notification, { userId: EDITOR, type: 't', title: 'x', body: 'y', data: {} });

      await h.moduleRef.get(UserDeletionHooks).run(EDITOR);
      await h.db.repository(User).softDelete({ id: EDITOR });
      await service.notify({ userId: EDITOR, type: 't', category: 'tripActivity', tripId: null, data: {}, render: () => ({ title: 'a', body: 'b' }) });

      expect(h.db.all(PushToken, { userId: EDITOR })).toEqual([]);
      expect(inbox(EDITOR)).toEqual([]);
      void trip;
    });
  });
});

function isoIn(days: number) {
  return new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
}

// Keep Trip imported for the seeds' types.
void Trip;
