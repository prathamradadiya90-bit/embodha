import { HttpException, ParseUUIDPipe } from '@nestjs/common';

/**
 * Every error the API sends has a stable `code` the apps can switch on, and a sentence a person can read.
 * Extra fields (prices on a locked chapter, for example) ride along in the same body.
 */
export function fail(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return new HttpException({ code, message, ...extra }, status);
}

export const uuidParam = new ParseUUIDPipe({ exceptionFactory: () => fail(400, 'invalid_id', 'That ID is not valid.') });

export function stripUndefined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}
