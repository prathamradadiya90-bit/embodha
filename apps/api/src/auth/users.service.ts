import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { fail, stripUndefined } from '../common/errors';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { Db, InjectDb } from '../db/db.module';
import { instructors, sessions, staffRoles, userPreferences, users } from '../db/schema';
import { UpdateMeDto } from './users.dto';

const DELETE_GRACE_DAYS = 30;

function isTimezone(zone: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

@Injectable()
export class UsersService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async me(userId: string) {
    const [row] = await this.db
      .select({ user: users, prefs: userPreferences })
      .from(users)
      .leftJoin(userPreferences, eq(userPreferences.userId, users.id))
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) throw fail(404, 'not_found', 'Account not found.');
    const [staff, instructorRows] = await Promise.all([
      this.db.select({ role: staffRoles.role }).from(staffRoles).where(eq(staffRoles.userId, userId)),
      this.db
        .select({ id: instructors.id, slug: instructors.slug, status: instructors.status })
        .from(instructors)
        .where(eq(instructors.userId, userId))
        .limit(1),
    ]);
    const { user, prefs } = row;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      country: user.country,
      state: user.state,
      birthYear: user.birthYear,
      gender: user.gender,
      timezone: user.timezone,
      createdAt: user.createdAt,
      // The app shows the "tell us about you" screens until this is true. Members in India also pick their state.
      profileComplete: Boolean(user.name && user.country && user.birthYear && (user.country !== 'IN' || user.state)),
      preferences: {
        goals: prefs?.goals ?? [],
        reminderTime: prefs?.reminderTime ?? null,
        breathOnLaunch: prefs?.breathOnLaunch ?? true,
        language: prefs?.language ?? 'en',
      },
      roles: { staff: staff.map((s) => s.role), instructor: instructorRows[0] ?? null },
    };
  }

  async update(userId: string, dto: UpdateMeDto) {
    const thisYear = new Date().getUTCFullYear();
    if (dto.birthYear !== undefined && dto.birthYear > thisYear - this.env.MIN_AGE) {
      throw fail(400, 'under_age', `Embodha is for adults: you need to be ${this.env.MIN_AGE} or over.`);
    }
    if (dto.timezone !== undefined && !isTimezone(dto.timezone)) {
      throw fail(400, 'invalid_timezone', 'That time zone is not recognised.');
    }
    const { goals, reminderTime, breathOnLaunch, language, ...profile } = dto;
    const userPatch = stripUndefined(profile);
    if (dto.country !== undefined || dto.state !== undefined) {
      // A state only means something in India; moving abroad clears it.
      const [current] = await this.db.select({ country: users.country }).from(users).where(eq(users.id, userId)).limit(1);
      if ((dto.country ?? current?.country) !== 'IN') userPatch.state = null;
    }
    const prefsPatch = stripUndefined({ goals, reminderTime, breathOnLaunch, language });
    await this.db.transaction(async (tx) => {
      if (Object.keys(userPatch).length) await tx.update(users).set(userPatch).where(eq(users.id, userId));
      if (Object.keys(prefsPatch).length) {
        await tx
          .insert(userPreferences)
          .values({ userId, ...prefsPatch })
          .onConflictDoUpdate({ target: userPreferences.userId, set: prefsPatch });
      }
    });
    return this.me(userId);
  }

  /** Signs the member out everywhere now; a nightly job hard-deletes after the grace period. Signing in again cancels it. */
  async requestDeletion(userId: string) {
    const deleteAfter = new Date(Date.now() + DELETE_GRACE_DAYS * 86_400_000);
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ status: 'deleting', deletedAt: new Date() }).where(eq(users.id, userId));
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    });
    return { status: 'deleting', deleteAfter };
  }
}
