import { Injectable, OnModuleInit } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';

@Injectable()
export class DatabaseMigrationsService implements OnModuleInit {
  constructor(private readonly orm: MikroORM) {}

  async onModuleInit(): Promise<void> {
    if (process.env.AUTO_MIGRATE !== 'false') {
      await this.orm.migrator.up();
    }
  }
}
