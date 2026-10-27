import { Inject, Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** Where a reply goes, if not back to Embodha's sending address. */
  replyTo?: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  private readonly transport?: nodemailer.Transporter;
  /** With the console transport, recent messages stay here so tests and local dev can read sign-in codes. */
  readonly outbox: Mail[] = [];

  constructor(@Inject(ENV) private readonly env: Env) {
    if (env.MAIL_TRANSPORT === 'smtp') {
      this.transport = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      });
    }
  }

  async send(mail: Mail): Promise<void> {
    if (!this.transport) {
      this.outbox.push(mail);
      if (this.outbox.length > 50) this.outbox.shift();
      this.logger.log(`To ${mail.to}: ${mail.subject}\n${mail.text}`);
      return;
    }
    await this.transport.sendMail({ from: this.env.MAIL_FROM, to: mail.to, replyTo: mail.replyTo, subject: mail.subject, text: mail.text, attachments: mail.attachments });
  }
}

export function signInMail(to: string, code: string, link: string, minutes: number): Mail {
  return {
    to,
    // Code first, so it shows on a lock screen without opening the email.
    subject: `${code} is your Embodha sign-in code`,
    text: [
      'Hi,',
      '',
      `Your sign-in code is ${code}. It works for ${minutes} minutes.`,
      '',
      'Reading this on your phone? Tap the link to sign in instead:',
      link,
      '',
      "If you didn't try to sign in, ignore this email. Nobody gets in without the code.",
      '',
      'Embodha',
    ].join('\n'),
  };
}
