import { prettyDate } from './dates.js';
import { firstName } from './contact.js';

export interface IndustryPreset {
  label: string;
  defaultIntervalDays: number;
  noun: string; // "appointment", "groom"
  thing: string; // what the discount applies to
}

export const INDUSTRIES: Record<string, IndustryPreset> = {
  salon: { label: 'Hair salon or barber', defaultIntervalDays: 42, noun: 'appointment', thing: 'your next appointment' },
  groomer: { label: 'Dog groomer', defaultIntervalDays: 49, noun: 'groom', thing: 'your pup’s next groom' },
  detailer: { label: 'Car detailer', defaultIntervalDays: 60, noun: 'detail', thing: 'your next detail' },
  fitness: { label: 'Fitness or yoga studio', defaultIntervalDays: 10, noun: 'class', thing: 'your next class' },
  nails: { label: 'Nail or lash studio', defaultIntervalDays: 21, noun: 'appointment', thing: 'your next appointment' },
  cafe: { label: 'Café or restaurant', defaultIntervalDays: 14, noun: 'visit', thing: 'your next visit' },
  other: { label: 'Other', defaultIntervalDays: 30, noun: 'visit', thing: 'your next purchase' },
};

export const industry = (key: string): IndustryPreset => INDUSTRIES[key] ?? INDUSTRIES.other!;

/** Days after the sequence starts that each step goes out. Never more than one message a week. */
export const STEP_OFFSETS_DAYS = [0, 7, 21] as const;
export const STEP_NAMES = ['Friendly check-in', 'Discount offer', 'Last call'] as const;
/** The discount code expires one week after the last-call message. */
export const CODE_VALID_DAYS = 28;

export interface MessageContext {
  step: number; // 0, 1, 2
  channel: 'sms' | 'email';
  businessName: string;
  industryKey: string;
  customerName: string;
  daysSince: number;
  learned: boolean;
  discountPct: number;
  code: string;
  expires: string; // YYYY-MM-DD
  bookingUrl?: string | null;
  unsubscribeUrl?: string;
  postalAddress?: string | null;
}

export interface RenderedMessage {
  subject: string;
  body: string;
}

function ago(days: number): string {
  if (days >= 60) return `${Math.round(days / 30)} months`;
  if (days >= 14) return `${Math.round(days / 7)} weeks`;
  return `${days} days`;
}

export function renderMessage(ctx: MessageContext): RenderedMessage {
  const p = industry(ctx.industryKey);
  const name = firstName(ctx.customerName);
  const hi = name ? `Hi ${name}` : 'Hi there';
  const exp = prettyDate(ctx.expires);
  const book = ctx.bookingUrl ? ` Book here: ${ctx.bookingUrl}` : ' Just reply to book.';
  const since = ctx.learned
    ? `It's been about ${ago(ctx.daysSince)} since your last ${p.noun}.`
    : `Thanks again for coming in ${ago(ctx.daysSince)} ago.`;
  const offer = ctx.discountPct > 0;

  let subject: string;
  let body: string;
  if (ctx.step === 0) {
    subject = `We miss you at ${ctx.businessName}`;
    body = `${hi}, it's ${ctx.businessName}. ${since} Want us to save you a spot this week?${book}`;
  } else if (ctx.step === 1) {
    subject = offer ? `${ctx.discountPct}% off ${p.thing}` : `Come see us at ${ctx.businessName}`;
    body = offer
      ? `${hi}, we'd love to see you again! Here's ${ctx.discountPct}% off ${p.thing} before ${exp}. Use code ${ctx.code}.${book}`
      : `${hi}, we'd love to see you again at ${ctx.businessName}.${book}`;
  } else {
    subject = offer ? `Your ${ctx.discountPct}% off code expires ${exp}` : `One last note from ${ctx.businessName}`;
    body = offer
      ? `Last reminder, ${name || 'friend'}: your ${ctx.discountPct}% off code ${ctx.code} expires ${exp}. After this we'll stop the reminders. Hope to see you soon! – ${ctx.businessName}`
      : `Last note from ${ctx.businessName}: we'd love to see you again whenever you're ready. We'll stop the reminders after this one.`;
  }

  if (ctx.channel === 'sms') {
    body += ' Reply STOP to opt out.';
  } else {
    const footer = [`—`, ctx.businessName, ctx.postalAddress ?? undefined, ctx.unsubscribeUrl ? `Don't want these emails? Unsubscribe: ${ctx.unsubscribeUrl}` : undefined]
      .filter(Boolean)
      .join('\n');
    body = `${body}\n\n${footer}`;
  }
  return { subject, body };
}

/** e.g. DANA15. Letters from the first name plus the discount percent. */
export function baseDiscountCode(customerName: string, pct: number): string {
  const letters = firstName(customerName).normalize('NFKD').replace(/[^a-z]/gi, '').toUpperCase().slice(0, 8);
  return `${letters || 'WELCOME'}${pct}`;
}
