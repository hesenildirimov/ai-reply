import nodemailer from 'nodemailer';
import { config } from './config.js';

const transport = config.SMTP_URL ? nodemailer.createTransport(config.SMTP_URL) : null;

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  if (!transport) {
    // Bodies can contain secret links: only print them in development.
    if (config.isProd) console.info(`[mail:skipped, SMTP_URL not set] subject=${subject}`);
    else console.info(`[mail:dev] to=${to} subject=${subject}\n${text}`);
    return;
  }
  await transport.sendMail({ from: config.MAIL_FROM, to, subject, text });
}
