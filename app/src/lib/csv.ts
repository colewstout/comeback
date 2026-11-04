import { parseLooseDate } from './dates.js';
import { normalizeEmail, normalizePhone } from './contact.js';

export function parseCsv(text: string): string[][] {
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
    else if (ch === ',') {
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
}

export interface MappedCsv {
  columns: { name?: string; firstName?: string; lastName?: string; phone?: string; email?: string; date: string; amount?: string; consent?: string };
  rows: ImportRow[];
  skipped: { line: number; reason: string }[];
}

export class CsvError extends Error {}

const HEADER_PATTERNS = {
  firstName: /^(first[ _-]?name|given[ _-]?name)$/,
  lastName: /^(last[ _-]?name|surname|family[ _-]?name)$/,
  name: /(^|[ _-])(name|customer|client|guest|member)([ _-]|$)/,
  email: /e-?mail/,
  phone: /phone|mobile|cell|tel/,
  date: /date|visit|purchase|created|time|day/,
  amount: /amount|total|spend|spent|price|revenue|sales|net|gross|paid/,
  consent: /consent|opt.?in|sms.?ok|text.?ok|marketing/,
};

function findColumn(headers: string[], re: RegExp, exclude: number[] = []): number {
  return headers.findIndex((h, i) => !exclude.includes(i) && re.test(h));
}

const YES = /^(y|yes|true|1|opted.?in|subscribed)$/i;
const NO = /^(n|no|false|0|opted.?out|unsubscribed)$/i;

export function mapCsv(text: string): MappedCsv {
  const table = parseCsv(text);
  if (table.length < 2) throw new CsvError('The file needs a header row and at least one purchase row.');
  const headers = table[0]!.map((h) => h.trim().toLowerCase());

  const iFirst = findColumn(headers, HEADER_PATTERNS.firstName);
  const iLast = findColumn(headers, HEADER_PATTERNS.lastName);
  const iEmail = findColumn(headers, HEADER_PATTERNS.email);
  const iPhone = findColumn(headers, HEADER_PATTERNS.phone);
  const iConsent = findColumn(headers, HEADER_PATTERNS.consent, [iEmail, iPhone]);
  const taken = [iFirst, iLast, iEmail, iPhone, iConsent];
  const iName = iFirst >= 0 ? -1 : findColumn(headers, HEADER_PATTERNS.name, taken);
  const iDate = findColumn(headers, HEADER_PATTERNS.date, [...taken, iName]);
  const iAmount = findColumn(headers, HEADER_PATTERNS.amount, [...taken, iName, iDate]);

  if (iDate < 0) throw new CsvError('Could not find a date column. Name it something like "date" or "visit date".');
  if (iName < 0 && iFirst < 0 && iEmail < 0 && iPhone < 0) {
    throw new CsvError('Could not find a customer column. Include a name, email, or phone column.');
  }

  const col = (i: number) => (i >= 0 ? table[0]![i]!.trim() : undefined);
  const rows: ImportRow[] = [];
  const skipped: { line: number; reason: string }[] = [];

  table.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    const cell = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
    const date = parseLooseDate(cell(iDate));
    if (!date) return skipped.push({ line, reason: `Unreadable date "${cell(iDate)}"` });

    const phone = normalizePhone(cell(iPhone));
    const email = normalizeEmail(cell(iEmail));
    const name = (iFirst >= 0 ? [cell(iFirst), cell(iLast)].filter(Boolean).join(' ') : cell(iName)) || email || phone || '';
    if (!name && !phone && !email) return skipped.push({ line, reason: 'No name, phone or email' });

    let amountCents = 0;
    if (iAmount >= 0) {
      const raw = cell(iAmount).replace(/[^0-9.\-]/g, '');
      const n = raw ? Number(raw) : 0;
      if (Number.isNaN(n)) return skipped.push({ line, reason: `Unreadable amount "${cell(iAmount)}"` });
      amountCents = Math.round(n * 100);
    }

    const consentRaw = cell(iConsent);
    const smsConsent = YES.test(consentRaw) ? true : NO.test(consentRaw) ? false : null;
    rows.push({ line, name, phone, email, date, amountCents, smsConsent });
  });

  return {
    columns: {
      name: col(iName), firstName: col(iFirst), lastName: col(iLast), phone: col(iPhone),
      email: col(iEmail), date: col(iDate)!, amount: col(iAmount), consent: col(iConsent),
    },
    rows,
    skipped,
  };
}

/** How rows are grouped into one customer: phone first, then email, then name. */
export function matchKey(row: { name: string; phone: string | null; email: string | null }): string {
  if (row.phone) return `p:${row.phone}`;
  if (row.email) return `e:${row.email}`;
  return `n:${row.name.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}
