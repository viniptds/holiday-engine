import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AppError } from './app-error.js';
import { toAppErrorBody } from './app-exception.filter.js';
import { appValidationPipe } from './app-validation.pipe.js';
import { IsString, MaxLength } from 'class-validator';

class SampleDto {
  @IsString()
  @MaxLength(3)
  name: string;
}

describe('toAppErrorBody', () => {
  it('maps an AppError to its status and body, keeping fields', () => {
    expect(toAppErrorBody(new AppError('CONFLICT', 'Already there', { email: 'taken' }))).toEqual({
      status: 409,
      body: { code: 'CONFLICT', message: 'Already there', fields: { email: 'taken' } },
    });
  });

  it.each([
    [new BadRequestException('bad'), 400, 'VALIDATION'],
    [new UnauthorizedException(), 401, 'UNAUTHENTICATED'],
    [new NotFoundException('Trip not found'), 404, 'NOT_FOUND'],
  ])('maps %s', (exception, status, code) => {
    expect(toAppErrorBody(exception)).toMatchObject({ status, body: { code } });
  });

  it('hides unexpected errors behind INTERNAL', () => {
    expect(toAppErrorBody(new Error('db password is hunter2'))).toEqual({
      status: 500,
      body: { code: 'INTERNAL', message: 'Something went wrong' },
    });
  });
});

describe('appValidationPipe', () => {
  const run = (value: unknown) =>
    appValidationPipe.transform(value, { type: 'body', metatype: SampleDto });

  it('reports field errors as VALIDATION', async () => {
    await expect(run({ name: 'toolong' })).rejects.toMatchObject({
      code: 'VALIDATION',
      fields: { name: expect.any(String) },
    });
  });

  it('rejects unknown fields', async () => {
    await expect(run({ name: 'ok', extra: 1 })).rejects.toMatchObject({ code: 'VALIDATION', fields: { extra: expect.any(String) } });
  });
});
