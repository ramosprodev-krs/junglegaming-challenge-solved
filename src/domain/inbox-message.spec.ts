import { describe, expect, test } from 'bun:test';
import { InboxMessage } from './inbox-message';

const receivedAt = new Date('2026-10-30T12:00:00.000Z');
const processedAt = new Date('2026-10-30T12:00:05.000Z');

describe('InboxMessage', () => {
  test('receives as unprocessed and records its processing time', () => {
    const message = InboxMessage.receive({
      messageId: 'message-1',
      consumerName: 'wager-processor',
      payloadHash: 'a'.repeat(64),
      receivedAt,
    });

    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
    message.markProcessed(processedAt);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toBe(processedAt);
  });

  test('rehydrates both pending and processed inbox records', () => {
    const common = {
      messageId: 'message-2',
      consumerName: 'wager-processor',
      payloadHash: 'b'.repeat(64),
      receivedAt,
    };

    expect(InboxMessage.rehydrate(common).isProcessed()).toBe(false);
    const processed = InboxMessage.rehydrate({ ...common, processedAt });
    expect(processed.isProcessed()).toBe(true);
    expect(processed.processedAt).toBe(processedAt);
  });
});
