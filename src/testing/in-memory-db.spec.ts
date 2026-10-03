import { InMemoryDb } from './in-memory-db.js';

// The fake's advisory locks must behave like Postgres's pg_advisory_xact_lock for the specs to mean anything.
describe('InMemoryDb advisory transaction locks', () => {
  const LOCK = 'SELECT pg_advisory_xact_lock(hashtext($1))';
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it('makes a second transaction wait for the same key until the first ends', async () => {
    const db = new InMemoryDb();
    const order: string[] = [];
    let finishFirst!: () => void;

    const first = db.transaction(async (m) => {
      await m.query(LOCK, ['k']);
      order.push('first locked');
      await new Promise<void>((resolve) => (finishFirst = resolve));
      order.push('first done');
    });
    await tick();
    const second = db.transaction(async (m) => {
      await m.query(LOCK, ['k']);
      order.push('second locked');
    });
    await tick();
    expect(order).toEqual(['first locked']);

    finishFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first locked', 'first done', 'second locked']);
  });

  it("doesn't block other keys, is re-entrant, and is released on rollback", async () => {
    const db = new InMemoryDb();
    await db.transaction(async (m) => {
      await m.query(LOCK, ['a']);
      await m.query(LOCK, ['a']);
      await db.transaction(async (other) => other.query(LOCK, ['b']));
    });
    await expect(
      db.transaction(async (m) => {
        await m.query(LOCK, ['a']);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    await expect(db.transaction(async (m) => m.query(LOCK, ['a']))).resolves.toEqual([{ pg_advisory_xact_lock: '' }]);
  });

  it('outside a transaction, waits for the holder and releases at once', async () => {
    const db = new InMemoryDb();
    let release!: () => void;
    const holder = db.transaction(async (m) => {
      await m.query(LOCK, ['k']);
      await new Promise<void>((resolve) => (release = resolve));
    });
    await tick();
    let done = false;
    const outside = db.manager(null).query(LOCK, ['k']).then(() => (done = true));
    await tick();
    expect(done).toBe(false);
    release();
    await Promise.all([holder, outside]);
    await expect(db.manager(null).query(LOCK, ['k'])).resolves.toBeDefined();
  });

  it('rejects SQL it does not understand', async () => {
    await expect(new InMemoryDb().manager(null).query('SELECT 1')).rejects.toThrow('unsupported query');
  });
});
