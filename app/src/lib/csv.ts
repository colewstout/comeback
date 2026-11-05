import { addDays, daysBetween, parseLooseDate } from './dates.js';
import { normalizeEmail, normalizePhone } from './contact.js';

export class CsvError extends Error {}

/** Comma, tab or semicolon: whichever the header row uses most. */
export function detectDelimiter(text: string): string {
  const firstLine = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', '\t', ';'].map((d) => [d, firstLine.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ',';
}

export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export interface ImportRow {
  line: number;
  name: string;
  phone: string | null;
  email: string | null;
  date: string;
  amountCents: number;
  smsConsent: boolean | null;
  /** Set for visits estimated from a customer-summary file (first/last visit and a visit count). */
  estimated?: { index: number };
}

export type CsvFormat = 'purchases' | 'customer_summary';

export interface MappedCsv {
  format: CsvFormat;
  columns: {
    name?: string; firstName?: string; lastName?: string; phone?: string; email?: string;
    date?: string; amount?: string; consent?: string; status?: string;
    lastVisit?: string; firstVisit?: string; visitCount?: string; totalSpend?: string;
  };
  rows: ImportRow[];
  skipped: { line: number; reason: string }[];
  /** Rows left out on purpose (cancelled, no-show, refunded…), not counted as problems. */
  excludedByStatus: number;
}

type Rule = { match: RegExp[]; exclude?: RegExp };

// Patterns are tried in order; the first one that matches any free column wins. Headers are
// lower-cased with underscores and repeated spaces turned into single spaces before matching.
const NOT_A_PERSON = /pet|dog|cat|animal|vehicle|car\b|make|model|employee|staff|groomer|stylist|tech|provider|service|item|product|business|company|location|team|nick|user|created by|assigned/;
const RULES: Record<string, Rule> = {
  firstName: { match: [/^(customer |client |owner |guest )?(first name|given name|first)$/] },
  lastName: { match: [/^(customer |client |owner |guest )?(last name|surname|family name|last)$/] },
  email: { match: [/^(customer |client |owner )?e-?mail( address)?$/, /e-?mail/], exclude: /subscri|status|opt|consent|marketing|verified|bounce/ },
  phone: { match: [/^(customer |client |owner )?(mobile|cell|cell phone|mobile phone|phone|phone number|telephone)( number)?$/, /mobile|cell|phone|\btel\b/], exclude: /opt|consent|sms|text|type|ext|work|fax|home/ },
  consent: { match: [/^(sms|text)( ok| okay| opt.?in| consent| allowed| marketing| subscribed| subscription)?$/, /(sms|text).*(consent|opt|ok|allow|subscri|marketing)|(consent|opt.?in).*(sms|text)/] },
  name: {
    match: [/^(customer|client|guest|member|owner|pet parent|pet owner|account|contact) ?(full )?name$/, /^(customer|client|guest|owner|pet parent|pet owner|contact)$/, /^(full )?name$/, /(customer|client|owner|parent|guest|contact).*name/],
    exclude: new RegExp(`${NOT_A_PERSON.source}|first|last|given|surname|id$|number`),
  },
  date: {
    match: [
      /^(date|visit date|service date|appointment date|appt date|transaction date|order date|purchase date|sale date|invoice date|issued( date)?|issue date|completed( date| at| on)?|completion date|check.?out( date| time)?|paid( date| at| on)?|payment date|closed( at| date)?|date of service)$/,
      /^(start|start date|start time|appointment|appointment time|scheduled( date| for)?|booking date)$/,
      /(service|appointment|appt|visit|transaction|order|invoice|purchase|sale|completed|checkout|payment|booking).*(date|time|on|at)$/,
      /date/,
      /^created( at| date| on)?$/,
    ],
    exclude: /due|birth|dob|updated|modified|next|last.?visit|first.?visit|last.?seen|since|anniversary|expir|sign.?up|join|vaccin|rabies|reminder/,
  },
  amount: {
    match: [/^(total collected|amount paid|paid amount|total paid|grand total|invoice total|order total|total|ticket total)$/, /^(net sales|gross sales|amount|price|subtotal|sale amount|revenue|charged)$/, /total|amount|paid|price|sales|revenue|charge/],
    exclude: /tip|gratuity|tax|discount|balance|due|fee|refund|deposit|lifetime|average|avg|outstanding|owing|credit|spend|spent|count|qty|quantity/,
  },
  status: { match: [/^(status|appointment status|appt status|invoice status|order status|payment status|booking status|state)$/] },
  lastVisit: { match: [/^(last|most recent|latest) (visit|appointment|appt|purchase|service|order|booking|seen)( date)?$/, /last.?(visit|appointment|appt|purchase|service|seen)/] },
  firstVisit: { match: [/^first (visit|appointment|appt|purchase|service|order|booking)( date)?$/, /^(customer|client|member) since$/, /first.?(visit|appointment|purchase|service)/, /^(created|date created|created at|date added)$/] },
  visitCount: { match: [/^(total |number of |# ?|no\.? of )?(visits|appointments|appts|transactions|orders|purchases|bookings|services)( count)?$/, /^(visit|appointment|appt|transaction|order|purchase|booking) (count|total)$/] },
  totalSpend: { match: [/^(lifetime|total) (spend|spent|sales|revenue|value|paid)$/, /^(total spent|spent|lifetime value|ltv)$/, /lifetime|total spen/] },
};

const SKIP_STATUS = /cancel|no.?show|void|refund|declin|fail|delet|draft|reject|abandon/;
const YES = /^(y|yes|true|1|opted.?in|subscribed|ok|allowed|granted)$/i;
const NO = /^(n|no|false|0|opted.?out|unsubscribed|denied|declined)$/i;

const normHeader = (h: string) => h.replace(/^﻿/, '').trim().toLowerCase().replace(/[_\s]+/g, ' ');

function pick(headers: string[], rule: Rule, taken: Set<number>): number {
  for (const re of rule.match) {
    const i = headers.findIndex((h, k) => !taken.has(k) && re.test(h) && !(rule.exclude && rule.exclude.test(h)));
    if (i >= 0) {
      taken.add(i);
      return i;
    }
  }
  return -1;
}

export function mapCsv(text: string): MappedCsv {
  // .xlsx files are zip archives, which start with "PK".
  if (/^PK[\u0003\u0005\u0007]/.test(text)) {
    throw new CsvError('This looks like an Excel file. Open it in Excel or Google Sheets and save or download it as CSV, then upload that.');
  }
  const table = parseCsv(text, detectDelimiter(text));
  if (table.length < 2) throw new CsvError('The file needs a header row and at least one row of data.');
  const headers = table[0]!.map(normHeader);
  const taken = new Set<number>();

  // Contact columns first, so a "Phone" column can't be mistaken for anything else.
  const iEmail = pick(headers, RULES.email!, taken);
  const iConsent = pick(headers, RULES.consent!, taken);
  const iPhone = pick(headers, RULES.phone!, taken);
  const iFirst = pick(headers, RULES.firstName!, taken);
  const iLast = iFirst >= 0 ? pick(headers, RULES.lastName!, taken) : -1;
  const iName = iFirst >= 0 ? -1 : pick(headers, RULES.name!, taken);
  // Summary columns are claimed before the generic date/amount rules so "Last visit" isn't read as a purchase date.
  const iLastVisit = pick(headers, RULES.lastVisit!, taken);
  const iFirstVisit = pick(headers, RULES.firstVisit!, taken);
  const iCount = pick(headers, RULES.visitCount!, taken);
  const iSpend = pick(headers, RULES.totalSpend!, taken);
  const iStatus = pick(headers, RULES.status!, taken);
  const iDate = pick(headers, RULES.date!, taken);
  const iAmount = pick(headers, RULES.amount!, taken);

  if (iName < 0 && iFirst < 0 && iEmail < 0 && iPhone < 0) {
    throw new CsvError('Could not find a customer column. Include the customer’s name, email or phone.');
  }
  const format: CsvFormat = iDate >= 0 ? 'purchases' : iLastVisit >= 0 ? 'customer_summary' : (() => {
    throw new CsvError('Could not find a date column. Use a file with one row per visit or purchase and a date column, or a customer list with a "Last visit" column.');
  })();

  const col = (i: number) => (i >= 0 ? table[0]![i]!.trim() : undefined);
  const rows: ImportRow[] = [];
  const skipped: { line: number; reason: string }[] = [];
  let excludedByStatus = 0;
  const money = (raw: string) => {
    const negative = /^\(.*\)$/.test(raw.trim()) || raw.includes('-');
    const n = Number(raw.replace(/[^0-9.]/g, '') || 0);
    return Number.isNaN(n) ? null : Math.round(n * 100) * (negative ? -1 : 1);
  };

  table.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    const cell = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
    if (iStatus >= 0 && SKIP_STATUS.test(cell(iStatus).toLowerCase())) { excludedByStatus++; return; }

    const phone = normalizePhone(cell(iPhone));
    const email = normalizeEmail(cell(iEmail));
    const name = (iFirst >= 0 ? [cell(iFirst), cell(iLast)].filter(Boolean).join(' ') : cell(iName)) || email || phone || '';
    if (!name && !phone && !email) return skipped.push({ line, reason: 'No name, phone or email' });
    const consentRaw = cell(iConsent);
    const smsConsent = YES.test(consentRaw) ? true : NO.test(consentRaw) ? false : null;

    if (format === 'purchases') {
      const date = parseLooseDate(cell(iDate));
      if (!date) return skipped.push({ line, reason: `Unreadable date "${cell(iDate)}"` });
      let amountCents = 0;
      if (iAmount >= 0) {
        const m = money(cell(iAmount));
        if (m === null) return skipped.push({ line, reason: `Unreadable amount "${cell(iAmount)}"` });
        if (m < 0) { excludedByStatus++; return; } // a refund row, not a visit
        amountCents = m;
      }
      rows.push({ line, name, phone, email, date, amountCents, smsConsent });
      return;
    }

    // Customer summary: spread the visit count evenly between first and last visit. The gaps
    // are an estimate, but the average gap — what the rhythm needs — is right.
    const last = parseLooseDate(cell(iLastVisit));
    if (!last) return skipped.push({ line, reason: cell(iLastVisit) ? `Unreadable last visit "${cell(iLastVisit)}"` : 'No last visit date' });
    const first = parseLooseDate(cell(iFirstVisit));
    const countRaw = Number(cell(iCount).replace(/[^0-9]/g, ''));
    const count = Math.max(1, Math.min(500, Number.isFinite(countRaw) && countRaw > 0 ? countRaw : 1));
    const spend = iSpend >= 0 ? money(cell(iSpend)) ?? 0 : 0;
    const perVisit = Math.max(0, Math.round(spend / count));
    const span = first && first < last ? daysBetween(first, last) : 0;
    const n = span > 0 ? Math.min(count, span + 1) : 1; // can't have more distinct visit days than days
    for (let k = 0; k < n; k++) {
      const date = n === 1 ? last : addDays(first!, Math.round((span * k) / (n - 1)));
      rows.push({ line, name, phone, email, date, amountCents: perVisit, smsConsent, estimated: { index: k } });
    }
  });

  return {
    format,
    columns: {
      name: col(iName), firstName: col(iFirst), lastName: col(iLast), phone: col(iPhone), email: col(iEmail),
      date: col(iDate), amount: col(iAmount), consent: col(iConsent), status: col(iStatus),
      lastVisit: format === 'customer_summary' ? col(iLastVisit) : undefined,
      firstVisit: format === 'customer_summary' ? col(iFirstVisit) : undefined,
      visitCount: format === 'customer_summary' ? col(iCount) : undefined,
      totalSpend: format === 'customer_summary' ? col(iSpend) : undefined,
    },
    rows,
    skipped,
    excludedByStatus,
  };
}

/** How rows are grouped into one customer: phone first, then email, then name. */
export function matchKey(row: { name: string; phone: string | null; email: string | null }): string {
  if (row.phone) return `p:${row.phone}`;
  if (row.email) return `e:${row.email}`;
  return `n:${row.name.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}
