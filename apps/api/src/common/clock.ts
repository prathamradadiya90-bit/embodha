import { Injectable } from '@nestjs/common';

/** The time, asked for in one place, so tests can set it. */
@Injectable()
export class Clock {
  now() {
    return new Date();
  }
}
