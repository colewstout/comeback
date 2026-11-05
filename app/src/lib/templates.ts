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

export type SequenceKind = 'winback' | 'second_visit';

/**
 * winback: for customers past their usual gap (check-in, discount, last call).
 * second_visit: for first-time customers before they drift away (thank-you offer, reminder).
 */
export const SEQUENCE_KINDS: Record<SequenceKind, { offsets: readonly number[]; names: readonly string[]; codeValidDays: number }> = {
  winback: { offsets: STEP_OFFSETS_DAYS, names: STEP_NAMES, codeValidDays: CODE_VALID_DAYS },
  second_visit: { offsets: [0, 10], names: ['Thank-you offer', 'Reminder'], codeValidDays: 21 },
};

/** Words owners can use in their own message wording. */
export const PLACEHOLDERS: Record<string, string> = {
  first_name: 'Customer’s first name (or “there”)',
  business: 'Your business name',
  since: 'Time since their last visit, like “about 6 weeks”',
  discount: 'The discount, like “15%”',
  code: 'Their personal discount code',
  expires: 'When the code expires, like “Dec 2”',
  booking: 'Your booking link (or “Just reply to book.”)',
};

export type MessageTemplates = Partial<Record<SequenceKind, (string | null)[]>>;
export const MAX_TEMPLATE_LENGTH = 480;

/** Problems with an owner's wording, or [] if it's fine. */
export function templateProblems(text: string, opts: { needsCode: boolean }): string[] {
  const problems: string[] = [];
  if (!text.trim()) problems.push('The message is empty.');
  if (text.length > MAX_TEMPLATE_LENGTH) problems.push(`Keep it under ${MAX_TEMPLATE_LENGTH} characters.`);
  for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
    if (!(m[1]! in PLACEHOLDERS)) problems.push(`{${m[1]}} isn't a word we can fill in. Use one of: ${Object.keys(PLACEHOLDERS).map((k) => `{${k}}`).join(', ')}.`);
  }
  if (opts.needsCode && !text.includes('{code}')) problems.push('Include {code} so the customer knows how to use the discount.');
  if (/reply stop|unsubscribe/i.test(text)) problems.push('Leave out opt-out wording. We add “Reply STOP to opt out” or an unsubscribe link automatically.');
  return problems;
}

function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (all, k: string) => (k in values ? values[k]! : all)).replace(/\s{2,}/g, ' ').trim();
}

export interface MessageContext {
  step: number; // 0, 1, 2
  kind?: SequenceKind; // default 'winback'
  templates?: MessageTemplates | null; // owner's own wording, if any
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
  const kind = ctx.kind ?? 'winback';

  let subject: string;
  let body: string;
  const custom = ctx.templates?.[kind]?.[ctx.step];
  if (custom && custom.trim()) {
    body = fill(custom, {
      first_name: name || 'there', business: ctx.businessName, since: `about ${ago(ctx.daysSince)}`,
      discount: `${ctx.discountPct}%`, code: ctx.code, expires: exp, booking: book.trim(),
    });
    subject = kind === 'second_visit' ? `Thanks for visiting ${ctx.businessName}` : ctx.step === 0 ? `We miss you at ${ctx.businessName}` : `A note from ${ctx.businessName}`;
  } else if (kind === 'second_visit') {
    subject = ctx.step === 0 ? `Thanks for visiting ${ctx.businessName}` : `Your offer from ${ctx.businessName}`;
    body = ctx.step === 0
      ? offer
        ? `${hi}, thanks again for choosing ${ctx.businessName}! We'd love to see you again: here's ${ctx.discountPct}% off ${p.thing} before ${exp}. Use code ${ctx.code}.${book}`
        : `${hi}, thanks again for choosing ${ctx.businessName}! We'd love to see you again soon.${book}`
      : offer
        ? `Quick reminder, ${name || 'friend'}: your ${ctx.discountPct}% off code ${ctx.code} for ${ctx.businessName} expires ${exp}.${book}`
        : `Quick note from ${ctx.businessName}: we'd love to see you again whenever you're ready.${book}`;
  } else if (ctx.step === 0) {
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
