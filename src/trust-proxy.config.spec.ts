import { Controller, Get, INestApplication, Req } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { applyTrustProxy, trustProxySetting } from './trust-proxy.config.js';

describe('trustProxySetting (TRUST_PROXY)', () => {
  it('is off when unset or empty', () => {
    expect(trustProxySetting(undefined)).toBeUndefined();
    expect(trustProxySetting('  ')).toBeUndefined();
  });

  it('maps true to the first hop and reads hop counts', () => {
    expect(trustProxySetting('true')).toBe(1);
    expect(trustProxySetting('1')).toBe(1);
    expect(trustProxySetting(' 2 ')).toBe(2);
  });

  it('passes address lists through', () => {
    expect(trustProxySetting('loopback, 10.0.0.0/8')).toBe('loopback,10.0.0.0/8');
    expect(trustProxySetting('127.0.0.1')).toBe('127.0.0.1');
    expect(trustProxySetting('fc00::/7,uniquelocal')).toBe('fc00::/7,uniquelocal');
  });

  it.each(['abc', 'yes', '-1', '1.5', '10.0.0.0/33', '10.0.0.0/8/8', 'loopback,,', '1,2', '99999999999999999999'])(
    'fails startup on %p',
    (value) => {
      expect(() => trustProxySetting(value)).toThrow(/^TRUST_PROXY must be/);
    },
  );
});

@Controller()
class IpController {
  @Get('ip')
  ip(@Req() req: { ip: string }) {
    return { ip: req.ip };
  }
}

describe('trust proxy on the Nest Express app (feature)', () => {
  let app: INestApplication;

  async function boot(value: string | undefined): Promise<string> {
    const moduleRef = await Test.createTestingModule({ controllers: [IpController] }).compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    applyTrustProxy(nest, trustProxySetting(value));
    await nest.listen(0, '127.0.0.1');
    app = nest;
    return nest.getUrl();
  }

  afterEach(async () => {
    await app?.close();
  });

  const ipFor = async (url: string) =>
    ((await (await fetch(`${url}/ip`, { headers: { 'x-forwarded-for': '203.0.113.7' } })).json()) as { ip: string }).ip;

  it('ignores X-Forwarded-For when unset', async () => {
    expect(await ipFor(await boot(undefined))).not.toBe('203.0.113.7');
  });

  it('uses X-Forwarded-For when set to 1', async () => {
    expect(await ipFor(await boot('1'))).toBe('203.0.113.7');
  });

  it('uses X-Forwarded-For when the peer is in the trusted list', async () => {
    expect(await ipFor(await boot('loopback'))).toBe('203.0.113.7');
  });
});
