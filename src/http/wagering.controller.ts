import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { WagerProcessorService } from '../application/wager-processor.service';
import { ProviderAuthGuard } from './provider-auth.guard';

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(private readonly processor: WagerProcessorService) {}

  @Post('wagering/transactions')
  @HttpCode(200)
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey?.trim()) {
      response.status(400);
      throw new TypeError('Idempotency-Key header is required');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new TypeError('Transaction body must be an object');
    }
    const result = await this.processor.submitWager({ ...body, idempotencyKey }) as {
      status: string;
      duplicateMessage?: boolean;
    };
    if (result.duplicateMessage) {
      response.status(200);
      return { duplicateMessage: true };
    }
    if (result.status === 'PENDING' || result.status === 'PENDING_REFERENCE') response.status(202);
    if (result.status === 'REJECTED') response.status(422);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  get(@Param('transactionId', new ParseUUIDPipe()) transactionId: string) {
    return this.processor.getTransaction(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getByProvider(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.processor.getProviderTransaction(providerId, externalTransactionId);
  }
}
