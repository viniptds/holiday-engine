import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { databaseConfig } from './database.config.js';

describe('entity metadata (what TypeORM validates at startup)', () => {
  it('builds for every registered entity without connecting', async () => {
    const options = databaseConfig(new ConfigService({})) as DataSourceOptions;
    const dataSource = new DataSource({ ...options, migrationsRun: false } as DataSourceOptions);

    // Builds and validates the metadata (e.g. composite primary keys naming one constraint); no connection.
    await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();

    expect(dataSource.entityMetadatas.map((m) => m.tableName)).toEqual(expect.arrayContaining(['trip_journey_skips', 'moments', 'user_achievements', 'leads']));
    expect(dataSource.getMetadata('trip_journey_skips').primaryColumns.map((c) => c.propertyName).sort()).toEqual(['key', 'tripId']);
  });
});
