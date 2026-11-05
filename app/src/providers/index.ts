import type { Config } from '../config.js';

export interface SendResult {
  providerId: string;
}

export interface SmsProvider {
  name: string;
  /** True when every message needs a real sending number (the business's own, or this default). */
  requiresSender?: boolean;
  defaultFrom?: string;
  send(msg: { to: string; from?: string | null; body: string }): Promise<SendResult>;
}

export interface EmailProvider {
  name: string;
  send(msg: {
    to: string;
    fromName: string;
    replyTo?: string | null;
    subject: string;
    text: string;
    headers?: Record<string, string>;
  }): Promise<SendResult>;
}

export interface Providers {
  sms: SmsProvider | null; // null = texting unavailable, email only
  email: EmailProvider | null;
}

/** Twilio's REST API, called directly to avoid a heavy SDK. */
export function twilioSms(accountSid: string, authToken: string, defaultFrom: string | undefined): SmsProvider {
  return {
    name: 'twilio',
    requiresSender: true,
    defaultFrom,
    async send({ to, from, body }) {
      const sender = from || defaultFrom;
      if (!sender) throw new Error('No sending number. Set TWILIO_FROM_NUMBER or the business sms_from number.');
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: sender, Body: body }),
      });
      const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
      if (!res.ok || !json.sid) throw new Error(`Twilio error ${res.status}: ${json.message ?? 'unknown'}`);
      return { providerId: json.sid };
    },
  };
}

/** Resend's REST API. EMAIL_FROM must be an address on a domain verified in Resend. */
export function resendEmail(apiKey: string, fromAddress: string): EmailProvider {
  return {
    name: 'resend',
    async send({ to, fromName, replyTo, subject, text, headers }) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `${fromName.replace(/[<>"]/g, '')} <${fromAddress}>`,
          to: [to],
          subject,
          text,
          reply_to: replyTo || undefined,
          headers,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!res.ok || !json.id) throw new Error(`Resend error ${res.status}: ${json.message ?? 'unknown'}`);
      return { providerId: json.id };
    },
  };
}

/** Development stand-in: prints messages instead of sending them. */
export function consoleSms(log: (s: string) => void = console.log): SmsProvider {
  let n = 0;
  return { name: 'console', async send({ to, body }) { log(`[sms → ${to}] ${body}`); return { providerId: `console-sms-${++n}` }; } };
}
export function consoleEmail(log: (s: string) => void = console.log): EmailProvider {
  let n = 0;
  return {
    name: 'console',
    async send({ to, subject, text }) { log(`[email → ${to}] ${subject}\n${text}`); return { providerId: `console-email-${++n}` }; },
  };
}

export function providersFromConfig(c: Config): Providers {
  const prod = c.NODE_ENV === 'production';
  const sms = c.TWILIO_ACCOUNT_SID && c.TWILIO_AUTH_TOKEN
    ? twilioSms(c.TWILIO_ACCOUNT_SID, c.TWILIO_AUTH_TOKEN, c.TWILIO_FROM_NUMBER)
    : prod ? null : consoleSms();
  const email = c.RESEND_API_KEY && c.EMAIL_FROM
    ? resendEmail(c.RESEND_API_KEY, c.EMAIL_FROM)
    : prod ? null : consoleEmail();
  return { sms, email };
}
