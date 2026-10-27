import { CanActivate, ExecutionContext, Injectable, SetMetadata, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { and, eq } from 'drizzle-orm';
import type { Request } from 'express';
import { Db, InjectDb } from '../db/db.module';
import { STAFF_ROLES, instructors, staffRoles, users } from '../db/schema';
import { fail } from './errors';

export interface AuthUser {
  id: string;
  email: string;
  country: string | null;
  sessionId: string;
}

export interface InstructorRef {
  id: string;
  slug: string;
}

export type StaffRole = (typeof STAFF_ROLES)[number];

interface AuthedRequest extends Request {
  user?: AuthUser;
  instructor?: InstructorRef;
  staffRoles?: StaffRole[];
}

abstract class BearerGuard implements CanActivate {
  protected abstract readonly optional: boolean;

  constructor(
    private readonly jwt: JwtService,
    @InjectDb() private readonly db: Db,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      if (this.optional) return true;
      throw fail(401, 'unauthenticated', 'Sign in to continue.');
    }
    let payload: { sub: string; sid: string };
    try {
      payload = await this.jwt.verifyAsync<{ sub: string; sid: string }>(header.slice(7));
    } catch {
      // Even on public routes a stale token is an error: the app should refresh, not quietly see guest prices.
      throw fail(401, 'token_expired', 'Your session needs refreshing.');
    }
    const [user] = await this.db
      .select({ id: users.id, email: users.email, country: users.country, status: users.status })
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1);
    if (!user || user.status !== 'active') throw fail(401, 'account_unavailable', 'This account is no longer active.');
    req.user = { id: user.id, email: user.email, country: user.country, sessionId: payload.sid };
    return true;
  }
}

/** Requires a signed-in member. */
@Injectable()
export class AuthGuard extends BearerGuard {
  protected readonly optional = false;
}

/** Lets guests through; recognises members who send a token. */
@Injectable()
export class OptionalAuthGuard extends BearerGuard {
  protected readonly optional = true;
}

/** Use after AuthGuard. Lets approved instructors into the studio. */
@Injectable()
export class InstructorGuard implements CanActivate {
  constructor(@InjectDb() private readonly db: Db) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) throw fail(401, 'unauthenticated', 'Sign in to continue.');
    const [row] = await this.db
      .select({ id: instructors.id, slug: instructors.slug })
      .from(instructors)
      .where(and(eq(instructors.userId, req.user.id), eq(instructors.status, 'approved')))
      .limit(1);
    if (!row) throw fail(403, 'not_instructor', 'The studio is for approved instructors.');
    req.instructor = row;
    return true;
  }
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().user,
);

export const CurrentInstructor = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().instructor,
);

const ROLES_KEY = 'staffRoles';

/** Narrows an admin route to some staff roles. Super admins pass every check. */
export const Roles = (...roles: StaffRole[]) => SetMetadata(ROLES_KEY, roles);

/** Use after AuthGuard. Lets Embodha staff into admin, checking `@Roles()` where a route sets it. */
@Injectable()
export class StaffGuard implements CanActivate {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) throw fail(401, 'unauthenticated', 'Sign in to continue.');
    const rows = await this.db.select({ role: staffRoles.role }).from(staffRoles).where(eq(staffRoles.userId, req.user.id));
    const roles = rows.map((row) => row.role);
    if (!roles.length) throw fail(403, 'not_staff', 'Admin is for Embodha staff.');
    const needed = this.reflector.getAllAndOverride<StaffRole[] | undefined>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (needed?.length && !roles.includes('super_admin') && !needed.some((role) => roles.includes(role))) {
      throw fail(403, 'forbidden', `This needs the ${needed.join(' or ')} role.`);
    }
    req.staffRoles = roles;
    return true;
  }
}
