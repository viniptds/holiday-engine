import { Controller, Get, HttpStatus, Inject, Logger, Param, Put, Req, Res, UseFilters } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from '../app-common/app-error.js';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { OBJECT_STORAGE } from './storage/object-storage.js';
import type { ObjectStorage } from './storage/object-storage.js';
import { FILES_PATH, InvalidFileTokenError, LocalObjectStorage, UploadTooLargeError } from './storage/local-storage.js';

const refused = () => new AppError('FORBIDDEN', 'This link is invalid or has expired');

/**
 * DEV ONLY: `STORAGE_DRIVER=local`'s signed URLs. No bearer token: the signed, expiring token in
 * the path is the authorization (like an S3 presigned URL). With s3 storage this route is a 404.
 */
@Controller(FILES_PATH)
@UseFilters(AppExceptionFilter)
export class FilesController {
  private readonly logger = new Logger(FilesController.name);

  constructor(@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage) {}

  @Put(':token')
  async upload(@Param('token') token: string, @Req() request: IncomingMessage, @Res() response: ServerResponse): Promise<void> {
    const local = this.local();
    const grant = this.verify(local, token, 'PUT');
    const contentType = request.headers['content-type'] ?? null;
    if (grant.ct && contentType?.split(';')[0].trim().toLowerCase() !== grant.ct) {
      throw new AppError('VALIDATION', 'Some fields are invalid', { 'content-type': `Content-Type must be ${grant.ct}` });
    }
    try {
      await local.write(grant, contentType, request);
    } catch (error) {
      if (error instanceof UploadTooLargeError) {
        response.writeHead(HttpStatus.PAYLOAD_TOO_LARGE, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: 'VALIDATION', message: 'The upload is larger than declared' }));
        return;
      }
      throw error;
    }
    response.writeHead(HttpStatus.OK).end();
  }

  @Get(':token')
  async download(@Param('token') token: string, @Res() response: ServerResponse): Promise<void> {
    const local = this.local();
    const file = await local.read(this.verify(local, token, 'GET'));
    if (!file) throw new AppError('NOT_FOUND', 'File not found');
    response.writeHead(HttpStatus.OK, {
      'content-type': file.contentType,
      'content-length': String(file.size),
      'cache-control': 'private, max-age=3600',
    });
    file.stream.pipe(response);
  }

  private local(): LocalObjectStorage {
    if (!(this.storage instanceof LocalObjectStorage)) throw new AppError('NOT_FOUND', 'Not found');
    return this.storage;
  }

  private verify(local: LocalObjectStorage, token: string, method: 'PUT' | 'GET') {
    try {
      return local.verify(token, method);
    } catch (error) {
      if (!(error instanceof InvalidFileTokenError)) throw error;
      // Never log the token (it's a credential).
      this.logger.debug(`Refused a ${method} /files request: ${error.message}`);
      throw refused();
    }
  }
}
