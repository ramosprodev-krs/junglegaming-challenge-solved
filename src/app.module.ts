import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { DatabaseMigrationsService } from './application/database-migrations.service';
import { WagerProcessorService } from './application/wager-processor.service';
import { HealthController, MetricsController } from './http/health.controller';
import { WalletsController } from './http/wallets.controller';
import { WageringController } from './http/wagering.controller';
import { ProviderAuthGuard } from './http/provider-auth.guard';
import { Migration20261030000000 } from './migrations/Migration20261030000000';
import { SqsService } from './infrastructure/sqs.service';
import { WorkersService } from './infrastructure/workers.service';
import { persistenceEntities } from './infrastructure/persistence/entity-schemas';

@Module({
  imports: [
    MikroOrmModule.forRoot({
      driver: PostgreSqlDriver,
      clientUrl:
        process.env.DATABASE_URL ??
        'postgresql://wager:wager@localhost:5432/wager',
      entities: persistenceEntities,
      migrations: {
        migrationsList: [Migration20261030000000],
        tableName: 'mikro_orm_migrations',
      },
    }),
  ],
  controllers: [WalletsController, WageringController, HealthController, MetricsController],
  providers: [
    WagerProcessorService,
    ProviderAuthGuard,
    DatabaseMigrationsService,
    SqsService,
    WorkersService,
  ],
})
export class AppModule {}
