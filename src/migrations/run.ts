import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Migration20261030000000 } from './Migration20261030000000';
import { persistenceEntities } from '../infrastructure/persistence/entity-schemas';

async function run(): Promise<void> {
  const orm = await MikroORM.init({
    driver: PostgreSqlDriver,
    clientUrl:
      process.env.DATABASE_URL ??
      'postgresql://wager:wager@localhost:5432/wager',
    entities: persistenceEntities,
    migrations: {
      migrationsList: [Migration20261030000000],
      tableName: 'mikro_orm_migrations',
    },
  });
  try {
    if (process.argv[2] === 'down') await orm.migrator.down();
    else await orm.migrator.up();
  } finally {
    await orm.close(true);
  }
}

void run();
