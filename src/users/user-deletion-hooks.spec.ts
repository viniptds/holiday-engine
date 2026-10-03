import { UserDeletionHooks } from './user-deletion-hooks.js';

describe('UserDeletionHooks', () => {
  it('runs every registered hook in order with the user id', async () => {
    const hooks = new UserDeletionHooks();
    const calls: string[] = [];
    hooks.register(async (id) => void calls.push(`a:${id}`));
    hooks.register(async (id) => void calls.push(`b:${id}`));

    await hooks.run('u1');

    expect(calls).toEqual(['a:u1', 'b:u1']);
  });

  it('does nothing without hooks', async () => {
    await expect(new UserDeletionHooks().run('u1')).resolves.toBeUndefined();
  });

  it('stops at and rethrows the first failure', async () => {
    const hooks = new UserDeletionHooks();
    const calls: string[] = [];
    hooks.register(async () => {
      throw new Error('boom');
    });
    hooks.register(async () => void calls.push('second'));

    await expect(hooks.run('u1')).rejects.toThrow('boom');
    expect(calls).toEqual([]);
  });
});
