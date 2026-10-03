import { ExecutionContext } from '@nestjs/common';
import { AppError } from '../app-common/app-error.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { DevAuthGuard } from './dev-auth.guard.js';
import { StubUserDirectory } from './stub-user-directory.js';

const USER_ID = '7d0c5a8e-1f2b-4c3d-8e9f-0a1b2c3d4e5f';

function contextWith(headers: Record<string, string | undefined>) {
  const request: { headers: typeof headers; user?: AuthUser } = { headers };
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  return { request, context };
}

describe('DevAuthGuard', () => {
  const guard = new DevAuthGuard();
  const env = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = env;
  });

  it('attaches the dev headers as the AuthUser', () => {
    const { request, context } = contextWith({
      'x-dev-user-id': USER_ID.toUpperCase(),
      'x-dev-user-email': 'ana@example.com',
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(request.user).toEqual({ id: USER_ID, email: 'ana@example.com' });
  });

  it.each([
    ['no headers', {}],
    ['no email', { 'x-dev-user-id': USER_ID }],
    ['no id', { 'x-dev-user-email': 'ana@example.com' }],
    ['a non-v4 id', { 'x-dev-user-id': '00000000-0000-0000-0000-000000000000', 'x-dev-user-email': 'ana@example.com' }],
    ['a malformed email', { 'x-dev-user-id': USER_ID, 'x-dev-user-email': 'ana' }],
  ])('rejects %s with UNAUTHENTICATED', (_label, headers) => {
    const { request, context } = contextWith(headers);

    expect(() => guard.canActivate(context)).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
    expect(request.user).toBeUndefined();
  });

  it('refuses every request in production', () => {
    process.env.NODE_ENV = 'production';
    const { context } = contextWith({ 'x-dev-user-id': USER_ID, 'x-dev-user-email': 'ana@example.com' });

    expect(() => guard.canActivate(context)).toThrow(AppError);
  });
});

describe('StubUserDirectory', () => {
  it('names every user "Traveler <first 4 chars of id>" with no avatar', async () => {
    const profiles = await new StubUserDirectory().getProfiles([USER_ID]);

    expect(profiles.get(USER_ID)).toEqual({ id: USER_ID, displayName: 'Traveler 7d0c', avatarUrl: null });
  });
});
