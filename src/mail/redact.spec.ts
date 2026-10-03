import { redactLinks, redactValues } from './redact.js';

describe('redact', () => {
  it('replaces web and app links', () => {
    expect(redactLinks('Open: https://holid.ai/invite/abc?x=1 or holidai://invite/abc.')).toBe('Open: [link] or [link]');
  });

  it('replaces every occurrence of each value and ignores empty ones', () => {
    expect(redactValues('a@b.c sent a@b.c TOKEN', [['a@b.c', '[invitee]'], ['TOKEN', '[token]'], [null, 'x'], ['', 'y']])).toBe(
      '[invitee] sent [invitee] [token]',
    );
  });
});
