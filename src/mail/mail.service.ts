import {Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {createTransport, Transporter} from 'nodemailer';

/**
 * Sends email over SMTP when EMAIL_DELIVERY=smtp. Otherwise messages are written to the log,
 * which keeps local development and tests from emailing real addresses.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  private readonly from: string;

  constructor(config: ConfigService) {
    this.from = config.get<string>('MAIL_FROM') || 'PostPilot <no-reply@postpilot.local>';
    const enabled = config.get<string>('EMAIL_DELIVERY') === 'smtp' && config.get<string>('SMTP_HOST');
    this.transporter = enabled
      ? createTransport({
          host: config.get<string>('SMTP_HOST'),
          port: Number(config.get<string>('SMTP_PORT') || 587),
          secure: String(config.get<string>('SMTP_SECURE')) === 'true',
          auth: config.get<string>('SMTP_USER')
            ? {user: config.get<string>('SMTP_USER'), pass: config.get<string>('SMTP_PASS')}
            : undefined,
        })
      : null;
  }

  /** Never throws: a failed email must not fail the action that triggered it. */
  async send(to: string, subject: string, text: string) {
    if (!this.transporter) {
      this.logger.log(`[email:log-only] to=${to} subject="${subject}"\n${text}`);
      return false;
    }
    try {
      await this.transporter.sendMail({from: this.from, to, subject, text});
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Email to ${to} failed: ${message}`);
      return false;
    }
  }
}
