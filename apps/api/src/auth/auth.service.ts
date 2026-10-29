import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, count, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { hmacSha256, randomCode, randomToken, safeEqual, sha256 } from '../common/crypto';
import { fail } from '../common/errors';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { Db, InjectDb } from '../db/db.module';
import { emailCodes, sessions, staffRoles, userPreferences, users } from '../db/schema';
import { MailService, signInMail } from '../mail/mail.service';

const MAX_ATTEMPTS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SignInContext {
  ip?: string;
  deviceId?: string;
  userAgent?: string;
}

export interface TokenPair {
  accessToken: string;
  /** `<session id>.<secret>`. Single use: every refresh hands back a new one. */
  refreshToken: string;
  expiresInS: number;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

@Injectable()
export class AuthService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
  ) {}

  /** Same answer whether or not the address has an account, so the endpoint can't be used to find members. */
  async startEmail(rawEmail: string, ctx: SignInContext) {
    const email = normalizeEmail(rawEmail);
    const hourAgo = new Date(Date.now() - 3_600_000);

    const [toEmail] = await this.db
      .select({ n: count() })
      .from(emailCodes)
      .where(and(eq(emailCodes.email, email), gt(emailCodes.createdAt, hourAgo)));
    if (toEmail.n >= this.env.SIGNIN_CODES_PER_EMAIL_PER_HOUR) {
      throw fail(429, 'too_many_codes', 'We have sent several codes to this address already. Use the latest one, or try again in an hour.');
    }
    if (ctx.ip) {
      const [fromIp] = await this.db
        .select({ n: count() })
        .from(emailCodes)
        .where(and(eq(emailCodes.ip, ctx.ip), gt(emailCodes.createdAt, hourAgo)));
      if (fromIp.n >= this.env.SIGNIN_CODES_PER_IP_PER_HOUR) {
        throw fail(429, 'too_many_codes', 'Too many sign-in attempts from this network. Try again in an hour.');
      }
    }

    const reviewAccount = this.isReviewAccount(email);
    const code = reviewAccount ? this.env.REVIEW_ACCOUNT_CODE! : randomCode();
    const linkToken = randomToken();
    await this.db.transaction(async (tx) => {
      // Only the newest code works: asking again retires the earlier ones.
      await tx
        .update(emailCodes)
        .set({ consumedAt: new Date() })
        .where(and(eq(emailCodes.email, email), isNull(emailCodes.consumedAt)));
      await tx.insert(emailCodes).values({
        email,
        codeHash: this.codeHash(email, code),
        linkHash: sha256(linkToken),
        expiresAt: new Date(Date.now() + this.env.SIGNIN_CODE_TTL_S * 1000),
        ip: ctx.ip,
        deviceId: ctx.deviceId,
      });
    });

    if (!reviewAccount) {
      const link = `${this.env.WEB_URL}/auth/link?token=${linkToken}`;
      try {
        await this.mail.send(signInMail(email, code, link, Math.round(this.env.SIGNIN_CODE_TTL_S / 60)));
      } catch {
        throw fail(502, 'email_failed', "We couldn't send the email just now. Try again in a minute.");
      }
    }
    return { sent: true, expiresInS: this.env.SIGNIN_CODE_TTL_S };
  }

  async verifyCode(rawEmail: string, code: string, ctx: SignInContext) {
    const email = normalizeEmail(rawEmail);
    const [row] = await this.db
      .select()
      .from(emailCodes)
      .where(and(eq(emailCodes.email, email), isNull(emailCodes.consumedAt), gt(emailCodes.expiresAt, new Date())))
      .orderBy(desc(emailCodes.createdAt))
      .limit(1);
    if (!row) throw fail(400, 'code_expired', 'That code has expired or was already used. Ask for a new one.');
    if (row.attempts >= MAX_ATTEMPTS) throw fail(429, 'too_many_attempts', 'Too many wrong codes. Ask for a new one.');
    if (!safeEqual(row.codeHash, this.codeHash(email, code))) {
      await this.db
        .update(emailCodes)
        .set({ attempts: sql`${emailCodes.attempts} + 1` })
        .where(eq(emailCodes.id, row.id));
      throw fail(400, 'code_invalid', "That code doesn't match. Check the most recent email from us.");
    }
    await this.consume(row.id);
    return this.signIn(email, ctx);
  }

  async verifyLink(token: string, ctx: SignInContext) {
    const [row] = await this.db
      .select()
      .from(emailCodes)
      .where(and(eq(emailCodes.linkHash, sha256(token)), isNull(emailCodes.consumedAt), gt(emailCodes.expiresAt, new Date())))
      .limit(1);
    if (!row) throw fail(400, 'link_expired', 'That sign-in link has expired or was already used. Ask for a new one.');
    await this.consume(row.id);
    return this.signIn(row.email, ctx);
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const expired = () => fail(401, 'session_expired', 'Please sign in again.');
    const [sessionId, secret] = refreshToken.split('.');
    if (!sessionId || !secret || !UUID.test(sessionId)) throw expired();

    const [session] = await this.db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session || session.revokedAt || session.expiresAt <= new Date()) throw expired();

    const presented = sha256(secret);
    if (presented !== session.refreshTokenHash) {
      // A token we already swapped came back. Someone else may hold this session, so end it for everyone.
      if (presented === session.previousTokenHash) await this.revoke(session.id);
      throw expired();
    }

    const next = randomToken();
    const rotated = await this.db
      .update(sessions)
      .set({ previousTokenHash: presented, refreshTokenHash: sha256(next), lastUsedAt: new Date(), expiresAt: await this.refreshExpiry(session.userId) })
      .where(and(eq(sessions.id, session.id), eq(sessions.refreshTokenHash, presented)))
      .returning({ id: sessions.id });
    if (!rotated.length) throw expired();

    const [user] = await this.db.select({ status: users.status }).from(users).where(eq(users.id, session.userId)).limit(1);
    if (user?.status !== 'active') throw expired();
    return {
      accessToken: await this.accessToken(session.userId, session.id),
      refreshToken: `${session.id}.${next}`,
      expiresInS: this.env.ACCESS_TOKEN_TTL_S,
    };
  }

  async logout(sessionId: string) {
    await this.revoke(sessionId);
  }

  private async consume(id: string) {
    const done = await this.db
      .update(emailCodes)
      .set({ consumedAt: new Date() })
      .where(and(eq(emailCodes.id, id), isNull(emailCodes.consumedAt)))
      .returning({ id: emailCodes.id });
    if (!done.length) throw fail(400, 'code_expired', 'That code was already used. Ask for a new one.');
  }

  private async signIn(email: string, ctx: SignInContext) {
    let isNewUser = false;
    let [user] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      const created = await this.db.insert(users).values({ email }).onConflictDoNothing({ target: users.email }).returning();
      if (created.length) {
        user = created[0];
        isNewUser = true;
        await this.db.insert(userPreferences).values({ userId: user.id }).onConflictDoNothing();
      } else {
        [user] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
      }
    }
    if (user.status === 'deleting') {
      // Signing in during the 30-day grace period cancels the deletion.
      [user] = await this.db.update(users).set({ status: 'active', deletedAt: null }).where(eq(users.id, user.id)).returning();
    }
    if (user.status !== 'active') throw fail(403, 'account_unavailable', 'This account is suspended. Write to support if that looks wrong.');
    return { ...(await this.createSession(user.id, ctx)), isNewUser };
  }

  private async createSession(userId: string, ctx: SignInContext): Promise<TokenPair> {
    const secret = randomToken();
    const [session] = await this.db
      .insert(sessions)
      .values({ userId, refreshTokenHash: sha256(secret), deviceId: ctx.deviceId, userAgent: ctx.userAgent, expiresAt: await this.refreshExpiry(userId) })
      .returning({ id: sessions.id });
    return {
      accessToken: await this.accessToken(userId, session.id),
      refreshToken: `${session.id}.${secret}`,
      expiresInS: this.env.ACCESS_TOKEN_TTL_S,
    };
  }

  private accessToken(userId: string, sessionId: string) {
    return this.jwt.signAsync({ sub: userId, sid: sessionId });
  }

  /** Members stay signed in for 60 days of use; staff, who can move money, for 12 hours of it. */
  private async refreshExpiry(userId: string) {
    const [staff] = await this.db.select({ n: count() }).from(staffRoles).where(eq(staffRoles.userId, userId));
    const ms = staff.n ? this.env.STAFF_SESSION_TTL_HOURS * 3_600_000 : this.env.REFRESH_TOKEN_TTL_DAYS * 86_400_000;
    return new Date(Date.now() + ms);
  }

  private async revoke(sessionId: string) {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
  }

  private codeHash(email: string, code: string) {
    return hmacSha256(this.env.CODE_SECRET, `${email}:${code}`);
  }

  private isReviewAccount(email: string) {
    const { REVIEW_ACCOUNT_EMAIL, REVIEW_ACCOUNT_CODE } = this.env;
    if (!REVIEW_ACCOUNT_EMAIL || !REVIEW_ACCOUNT_CODE) return false;
    const allowed = REVIEW_ACCOUNT_EMAIL.split(',').map((e) => normalizeEmail(e.trim()));
    return allowed.includes(email);
  }
}
