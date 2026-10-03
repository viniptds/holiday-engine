import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { INestApplication, Logger } from '@nestjs/common';
import { Trip } from '../trips/trip.entity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import type { TripRole } from '../app-trips/app-trips.types.js';
import { appDb } from '../testing/app-db.js';
import { accessTokens, appTestingModule, seedUser } from '../testing/app-testing.js';
import { TripInvite } from './trip-invite.entity.js';
import { MembersModule } from './members.module.js';
import { InvitesService } from './invites.service.js';
import { MAIL_TRANSPORT } from '../mail/mail.types.js';
import type { MailMessage, MailTransport } from '../mail/mail.types.js';
import type { InviteDto } from './members.types.js';

// QA gap specs for invite emails (qa/email-test-plan.md, case ids M-xx). Bugs are tagged with
// their BUGS.md id; `it.failing` marks a confirmed bug and starts failing once it's fixed.

const OWNER = 'a1111111-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const EDITOR = 'a2222222-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const USERS = [OWNER, EDITOR];
const HOUR = 3_600_000;
const LEVELS = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;
type Level = (typeof LEVELS)[number];
type Line = { level: Level | 'console'; text: string };

describe('Invite emails (QA feature)', () => {
  const db = appDb();
  let app: INestApplication;
  let baseUrl: string;
  let tokens: Record<string, string>;
  let transport: MailTransport;
  let invites: InvitesService;

  beforeAll(async () => {
    const moduleRef = await appTestingModule(db, [MembersModule], { APP_INVITE_BASE_URL: 'https://holid.example/' }).compile();
    tokens = await accessTokens(moduleRef, USERS);
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = `${await app.getUrl()}/app/v1`;
    transport = moduleRef.get(MAIL_TRANSPORT);
    invites = moduleRef.get(InvitesService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    db.clear();
    for (const id of USERS) seedUser(db, id);
    db.afterRead = undefined;
    db.beforeWrite = undefined;
    invites.sendTimeoutMs = 15_000;
    jest.restoreAllMocks();
  });

  const send = (path: string, user: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${tokens[user]}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const invite = async (tripId: string, user: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await send(`/trips/${tripId}/invites`, user, body, headers);
    await invites.whenEmailsSettled();
    return res;
  };

  function seedTrip(): string {
    const trip = db.seed(Trip, {
      provider: null,
      chatId: null,
      ownerUserId: OWNER,
      destination: 'Lisbon',
      startDate: '2026-11-01',
      endDate: '2026-11-05',
    });
    ([[OWNER, 'owner'], [EDITOR, 'editor']] as [string, TripRole][]).forEach(([userId, role], i) =>
      db.seed(TripMember, { tripId: trip.id, userId, role, joinedAt: new Date(Date.UTC(2026, 9, 1, 10, i)) }),
    );
    return trip.id;
  }

  /** An email invite row created `ago` ms back (counts toward the limits). */
  const pastEmailInvite = (tripId: string, ago: number, fields: Partial<TripInvite> = {}) =>
    db.seed(TripInvite, {
      tripId,
      email: `someone-${randomUUID()}@example.com`,
      tokenHash: randomUUID(),
      role: 'editor',
      createdBy: OWNER,
      expiresAt: new Date(Date.now() + 7 * 24 * HOUR),
      createdAt: new Date(Date.now() - ago),
      ...fields,
    });

  /** Every log line, at every level, plus console output. */
  function captureLogs() {
    const lines: Line[] = [];
    for (const level of LEVELS) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        lines.push({ level, text: args.map(String).join(' ') });
      });
    }
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push({ level: 'console', text: args.map(String).join(' ') });
      });
    }
    return lines;
  }

  /**
   * Pairs up reads of `trip_invites`: each read waits until a second one arrives, so two requests
   * read the counted rows before either inserts. A read left alone is released after 200 ms.
   */
  function pairInviteReads() {
    let waiting: (() => void)[] = [];
    db.afterRead = async (entity) => {
      if (entity !== TripInvite) return;
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length === 2) {
          const pair = waiting;
          waiting = [];
          pair.forEach((release) => release());
        } else {
          setTimeout(() => {
            waiting = waiting.filter((r) => r !== resolve);
            resolve();
          }, 200);
        }
      });
    };
  }

  describe('rate limits under concurrency (M-73)', () => {
    // BUG-019: the limits read rows, then insert, without a lock or a constraint.
    it('lets only one of two concurrent invites to the same recipient through (1 per 10 min)', async () => {
      const id = seedTrip();
      pairInviteReads();

      const results = await Promise.all([
        invite(id, OWNER, { email: 'bia@example.com' }),
        invite(id, EDITOR, { email: 'bia@example.com' }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 429]);
      expect(db.all(TripInvite, { tripId: id, email: 'bia@example.com' })).toHaveLength(1);
    });

    // BUG-019
    it('keeps the inviter at 20 email invites per 24 h when the last two arrive together', async () => {
      const id = seedTrip();
      for (let i = 0; i < 19; i += 1) pastEmailInvite(id, HOUR);
      pairInviteReads();

      const results = await Promise.all([
        invite(id, OWNER, { email: 'twentieth@example.com' }),
        invite(id, OWNER, { email: 'twenty-first@example.com' }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 429]);
      expect(db.all(TripInvite).filter((row) => row.createdBy === OWNER && row.email !== null)).toHaveLength(20);
    });

    it('still enforces the limits for requests that arrive one after another', async () => {
      const id = seedTrip();
      expect((await invite(id, OWNER, { email: 'bia@example.com' })).status).toBe(201);
      expect((await invite(id, EDITOR, { email: 'bia@example.com' })).status).toBe(429);
    });
  });

  describe('background send timeout (M-54a)', () => {
    // BUG-020: a send that times out keeps running; if it finishes later, the email goes out and the
    // mailer logs "emailed" after the service already logged the invite as failed.
    it('logs no success for an invite after its send timed out', async () => {
      const id = seedTrip();
      let release!: () => void;
      const delivered = jest.fn();
      jest.spyOn(transport, 'send').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => {
              delivered();
              resolve({ id: 'late-1' });
            };
          }),
      );
      const lines = captureLogs();
      invites.sendTimeoutMs = 50;

      const res = await invite(id, OWNER, { email: 'ana@example.com' });
      const created = (await res.json()) as InviteDto;
      release(); // the provider answers after the timeout
      await new Promise((resolve) => setImmediate(resolve));

      const forInvite = lines.filter((l) => l.text.includes(created.id));
      expect(forInvite.find((l) => l.level === 'warn')?.text).toBe(`Sending invite ${created.id} failed: timed out after 50 ms`);
      // Either the late delivery is suppressed, or at least it isn't reported as a success after the failure.
      expect(forInvite.filter((l) => l.level === 'log' && l.text.includes('emailed'))).toEqual([]);
    });
  });

  describe('no token at any level, no recipient at info/warn/error (M-53, M-55 to M-61, Q6)', () => {
    const RECIPIENT = 'Invitee.Person@Example.com';
    const normalized = RECIPIENT.toLowerCase();

    function assertClean(lines: Line[], created: InviteDto) {
      const token = created.url.split('/').pop()!;
      for (const { level, text } of lines) {
        expect({ level, text, hasToken: text.includes(token) }).toEqual({ level, text, hasToken: false });
        expect(text).not.toContain(created.url);
        expect(text).not.toContain(created.deepLink);
        if (level !== 'debug' && level !== 'verbose') {
          expect({ level, text, hasRecipient: text.toLowerCase().includes(normalized) }).toEqual({ level, text, hasRecipient: false });
        }
      }
    }

    it('on success with the default log driver', async () => {
      const id = seedTrip();
      const lines = captureLogs();

      const res = await invite(id, OWNER, { email: RECIPIENT }, { 'accept-language': 'es' });

      expect(res.status).toBe(201);
      expect(lines.length).toBeGreaterThan(0);
      assertClean(lines, (await res.json()) as InviteDto);
    });

    it('when the provider error echoes the address, the links and the token in several forms', async () => {
      const id = seedTrip();
      jest.spyOn(transport, 'send').mockImplementationOnce(async (message: MailMessage) => {
        const token = message.text.match(/invite\/([A-Za-z0-9_-]{43})/)![1];
        throw new Error(
          `550 <${message.to}> rejected; token=${token}; ` +
            `links: (${message.text.match(/https:\/\/\S+/)![0]}) and "holidai://invite/${token}".`,
        );
      });
      const lines = captureLogs();

      const res = await invite(id, OWNER, { email: RECIPIENT });

      expect(res.status).toBe(201);
      assertClean(lines, (await res.json()) as InviteDto);
    });

    // BUG-021: redaction matches the exact address only, so an echo in another case reaches the warn log.
    it('when the provider echoes the address in a different case', async () => {
      const id = seedTrip();
      jest.spyOn(transport, 'send').mockImplementationOnce(async (message: MailMessage) => {
        throw new Error(`550 5.1.1 <${message.to.toUpperCase()}>: Recipient address rejected`);
      });
      const lines = captureLogs();

      const res = await invite(id, OWNER, { email: RECIPIENT });

      assertClean(lines, (await res.json()) as InviteDto);
    });

    it('when the send times out', async () => {
      const id = seedTrip();
      jest.spyOn(transport, 'send').mockImplementationOnce(() => new Promise(() => undefined));
      const lines = captureLogs();
      invites.sendTimeoutMs = 30;

      const res = await invite(id, OWNER, { email: RECIPIENT });

      assertClean(lines, (await res.json()) as InviteDto);
    });

    it('in a 429: no recipient in the response, nothing logged with it', async () => {
      const id = seedTrip();
      await invite(id, OWNER, { email: RECIPIENT });
      const lines = captureLogs();

      const res = await invite(id, OWNER, { email: RECIPIENT });

      expect(res.status).toBe(429);
      expect(JSON.stringify(await res.json()).toLowerCase()).not.toContain(normalized);
      expect(lines.filter((l) => l.text.toLowerCase().includes(normalized))).toEqual([]);
    });
  });

  describe('recipient address (M-49, M-50)', () => {
    it('trims and lowercases the address before storing and sending', async () => {
      const id = seedTrip();
      const providerSend = jest.spyOn(transport, 'send');

      const res = await invite(id, OWNER, { email: '  Ana.Maria@Example.COM ' });

      expect(res.status).toBe(201);
      expect(((await res.json()) as InviteDto).email).toBe('ana.maria@example.com');
      expect(db.all(TripInvite)[0].email).toBe('ana.maria@example.com');
      expect((providerSend.mock.calls[0][0] as MailMessage).to).toBe('ana.maria@example.com');
    });

    it.each([
      ['a CRLF header injection', 'ana@example.com\r\nBcc: evil@attacker.example'],
      ['an LF header injection', 'ana@example.com\nBcc: evil@attacker.example'],
      ['two addresses', 'ana@example.com, evil@attacker.example'],
      ['a display-name form', 'Ana <ana@example.com>'],
      ['an address over 254 characters', `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`],
      ['a NUL character', 'ana\u0000@example.com'],
      ['a non-string', 42],
    ])('rejects %s with 400 and sends nothing', async (_label, email) => {
      const id = seedTrip();
      const providerSend = jest.spyOn(transport, 'send');

      const res = await invite(id, OWNER, { email });

      expect(res.status).toBe(400);
      expect(db.all(TripInvite)).toEqual([]);
      expect(providerSend).not.toHaveBeenCalled();
    });

    it('sends the email in the inviter\'s language even when the invitee is elsewhere (M-48)', async () => {
      const id = seedTrip();
      const providerSend = jest.spyOn(transport, 'send');

      await invite(id, OWNER, { email: 'ana@example.com' }, { 'accept-language': 'fr-FR, pt;q=0.8, en;q=0.5' });

      expect((providerSend.mock.calls[0][0] as MailMessage).subject).toBe('Tem um convite de viagem para você no Holid.ai');
    });
  });
});
