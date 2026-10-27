import { Module } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MeController } from './me.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [AuthController, MeController],
  providers: [AuthService, UsersService, MailService],
  exports: [MailService, UsersService],
})
export class AuthModule {}
