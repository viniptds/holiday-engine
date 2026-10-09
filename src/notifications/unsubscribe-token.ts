import { createHmac, timingSafeEqual } from 'node:crypto';

/** Signed, non-expiring token for an email's unsubscribe link: `<userId>.<hmac>` (base64url), keyed from JWT_SECRET. */
export class UnsubscribeTokens {
  private readonly key: Buffer;

  constructor(jwtSecret: string) {
    this.key = createHmac('sha256', jwtSecret).update('holidai:unsubscribe:v1').digest();
  }

  sign(userId: string): string {
    return `${Buffer.from(userId).toString('base64url')}.${this.mac(userId).toString('base64url')}`;
  }

  /** The user id, or null if the token is malformed or forged. */
  verify(token: string): string | null {
    const [encoded, signature, extra] = (token ?? '').split('.');
    if (!encoded || !signature || extra !== undefined) return null;
    const userId = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!/^[0-9a-f-]{36}$/.test(userId)) return null;
    const given = Buffer.from(signature, 'base64url');
    const expected = this.mac(userId);
    return given.length === expected.length && timingSafeEqual(given, expected) ? userId : null;
  }

  private mac(userId: string): Buffer {
    return createHmac('sha256', this.key).update(userId).digest();
  }
}
