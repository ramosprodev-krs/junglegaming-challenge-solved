import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { WagerProcessorService } from '../application/wager-processor.service';
import { ProviderAuthGuard } from './provider-auth.guard';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(private readonly processor: WagerProcessorService) {}

  @Post()
  create(@Body() body: { playerId: string; initialBalance: { amount: string; currency: string } }) {
    return this.processor.createWallet(body?.playerId, body?.initialBalance);
  }

  @Get(':walletId')
  get(@Param('walletId', new ParseUUIDPipe()) walletId: string) {
    return this.processor.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.processor.getLedger(walletId, cursor, limit);
  }

  @Post(':walletId/reconciliation')
  reconcile(@Param('walletId', new ParseUUIDPipe()) walletId: string) {
    return this.processor.reconcile(walletId);
  }
}
