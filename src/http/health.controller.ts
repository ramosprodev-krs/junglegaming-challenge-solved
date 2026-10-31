import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { WagerProcessorService } from '../application/wager-processor.service';
import { SqsService } from '../infrastructure/sqs.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly processor: WagerProcessorService,
    private readonly sqs: SqsService,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      await Promise.all([this.processor.databaseReady(), this.sqs.ready()]);
      return { status: 'ready', dependencies: { postgres: 'ok', sqs: 'ok' } };
    } catch {
      throw new ServiceUnavailableException({
        code: 'DEPENDENCY_UNAVAILABLE',
        dependencies: { postgres: 'unknown', sqs: 'unknown' },
      });
    }
  }
}

@Controller()
export class MetricsController {
  constructor(
    private readonly processor: WagerProcessorService,
    private readonly sqs: SqsService,
  ) {}

  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics() {
    const [baseMetrics, deadLetterMessages] = await Promise.all([
      this.processor.metrics(),
      this.sqs.deadLetterCount(),
    ]);
    return `${baseMetrics}# HELP wager_sqs_dlq_messages Current number of messages in the SQS dead-letter queue.\n# TYPE wager_sqs_dlq_messages gauge\nwager_sqs_dlq_messages ${deadLetterMessages}\n`;
  }
}
