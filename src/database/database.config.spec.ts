import { ConfigService } from '@nestjs/config';
import { databaseConfig } from './database.config.js';
import { migrations } from './migrations/index.js';
import { Trip } from '../trips/trip.entity.js';

function configFrom(env: Record<string, string>) {
  return new ConfigService(env);
}

describe('databaseConfig', () => {
  it('uses contract defaults when env is empty', () => {
    expect(databaseConfig(configFrom({}))).toMatchObject({
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      ssl: false,
      synchronize: false,
      migrationsRun: true,
      migrations,
    });
  });

  it('registers entities as classes, including Trip', () => {
    const { entities } = databaseConfig(configFrom({}));

    expect(entities).toEqual(expect.arrayContaining([Trip]));
    expect((entities as unknown[]).every((e) => typeof e === 'function')).toBe(true);
  });

  it('reads connection settings from env', () => {
    const config = databaseConfig(
      configFrom({
        PGHOST: 'db',
        PGPORT: '6543',
        PGUSER: 'u',
        PGPASSWORD: 'p',
        PGDATABASE: 'd',
      }),
    );

    expect(config).toMatchObject({ host: 'db', port: 6543, username: 'u', password: 'p', database: 'd' });
  });

  it.each(['true', 'TRUE', 'True'])('enables ssl and synchronize for %p', (value) => {
    const config = databaseConfig(configFrom({ PGSSL: value, DB_SYNCHRONIZE: value }));

    expect(config).toMatchObject({ ssl: { rejectUnauthorized: false }, synchronize: true });
  });

  it.each(['false', '1', 'yes', ''])('keeps ssl and synchronize off for %p', (value) => {
    const config = databaseConfig(configFrom({ PGSSL: value, DB_SYNCHRONIZE: value }));

    expect(config).toMatchObject({ ssl: false, synchronize: false });
  });
});

describe('migrations', () => {
  it('registers migrations in timestamp order, each named after its class', () => {
    const timestamps = migrations.map((m) => Number(/(\d{13})$/.exec(new m().name)?.[1]));

    expect(migrations.length).toBeGreaterThan(0);
    expect(timestamps.every(Number.isFinite)).toBe(true);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    expect(new Set(timestamps).size).toBe(timestamps.length);
    for (const m of migrations) expect(new m().name).toBe(m.name);
  });
});
