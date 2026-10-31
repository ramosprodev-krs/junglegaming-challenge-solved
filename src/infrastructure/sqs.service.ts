import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { Injectable, OnModuleDestroy } from '@nestjs/common';

@Injectable()
export class SqsService implements OnModuleDestroy {
  private readonly client: SQSClient;
  readonly transactionQueueUrl: string;
  readonly eventQueueUrl: string;
  readonly deadLetterQueueUrl: string;

  constructor() {
    const endpoint = process.env.SQS_ENDPOINT_URL;
    this.client = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      ...(endpoint
        ? {
            endpoint,
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
            },
          }
        : {}),
    });
    const accountId =
      process.env.AWS_ACCOUNT_ID ??
      process.env.LOCALSTACK_ACCOUNT_ID ??
      (endpoint ? '000000000000' : undefined);
    const base = endpoint ?? `https://sqs.${process.env.AWS_REGION ?? 'us-east-1'}.amazonaws.com`;
    this.transactionQueueUrl =
      process.env.SQS_TRANSACTION_QUEUE_URL ??
      (accountId ? `${base}/${accountId}/wager-transactions.fifo` : '');
    this.eventQueueUrl =
      process.env.SQS_EVENT_QUEUE_URL ??
      (accountId ? `${base}/${accountId}/wager-events.fifo` : '');
    this.deadLetterQueueUrl =
      process.env.SQS_DEAD_LETTER_QUEUE_URL ??
      (accountId ? `${base}/${accountId}/wager-transactions-dlq.fifo` : '');
    if (!this.transactionQueueUrl || !this.eventQueueUrl || !this.deadLetterQueueUrl) {
      throw new Error('Set SQS queue URLs or AWS_ACCOUNT_ID with the queue names provisioned');
    }
  }

  async sendEvent(aggregateId: string, eventId: string, body: string): Promise<void> {
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.eventQueueUrl,
      MessageBody: body,
      MessageGroupId: aggregateId,
      MessageDeduplicationId: eventId,
    }));
  }

  receiveTransaction() {
    return this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.transactionQueueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 2,
      VisibilityTimeout: 30,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }));
  }

  async acknowledge(receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({
      QueueUrl: this.transactionQueueUrl,
      ReceiptHandle: receiptHandle,
    }));
  }

  async ready(): Promise<boolean> {
    await Promise.all([
      this.client.send(new GetQueueAttributesCommand({
        QueueUrl: this.transactionQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      })),
      this.client.send(new GetQueueAttributesCommand({
        QueueUrl: this.eventQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      })),
      this.client.send(new GetQueueAttributesCommand({
        QueueUrl: this.deadLetterQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      })),
    ]);
    return true;
  }

  async deadLetterCount(): Promise<string> {
    const response = await this.client.send(new GetQueueAttributesCommand({
      QueueUrl: this.deadLetterQueueUrl,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }));
    return response.Attributes?.ApproximateNumberOfMessages ?? '0';
  }

  async onModuleDestroy(): Promise<void> {
    this.client.destroy();
  }
}
