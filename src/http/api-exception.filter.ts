import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  DomainError,
} from '../domain/domain-error';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    let status: number;
    let body: Record<string, unknown>;

    if (error instanceof HttpException) {
      status = error.getStatus();
      const payload = error.getResponse();
      body = typeof payload === 'string' ? { message: payload } : payload as Record<string, unknown>;
    } else if (error instanceof TypeError || error instanceof DomainError) {
      const code = 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'INVALID_REQUEST';
      const invalidPayload =
        error instanceof TypeError ||
        ['INVALID_MONEY', 'INVALID_WAGER_TRANSACTION', 'INVALID_WALLET_OPERATION'].includes(code);
      status = invalidPayload ? HttpStatus.BAD_REQUEST : HttpStatus.UNPROCESSABLE_ENTITY;
      body = { code, message: error.message };
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      body = { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' };
      console.error(JSON.stringify({
        event: 'http_request_failed',
        path: request.url,
        error: error instanceof Error ? error.message : 'unknown',
      }));
    }
    response.status(status).json({
      statusCode: status,
      ...body,
      path: request.url,
    });
  }
}
