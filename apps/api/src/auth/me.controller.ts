import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthUser, CurrentUser } from '../common/auth';
import { UpdateMeDto } from './users.dto';
import { UsersService } from './users.service';

@ApiTags('account')
@ApiBearerAuth()
@Controller('v1/me')
@UseGuards(AuthGuard)
export class MeController {
  constructor(private readonly users: UsersService) {}

  @Get()
  me(@CurrentUser() user: AuthUser) {
    return this.users.me(user.id);
  }

  @Patch()
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    return this.users.update(user.id, dto);
  }

  // DELETE /v1/me (deleting the account) is in the privacy module, because it also stops renewals.
}
