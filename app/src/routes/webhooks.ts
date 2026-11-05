import type { FastifyInstance } from 'fastify';
import { normalizePhone } from '../lib/contact.js';
import { twilioSignature, safeEqual, verifyStripeSignature, verifyToken } from '../lib/security.js';
import { handleStripeEvent } from '../services/billing.js';
import { stopSequences } from '../services/sequences.js';

const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE']);
const START_WORDS = new Set(['START', 'UNSTOP', 'YES']);

const page = (title: string, msg: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:17px/1.5 system-ui,sans-serif;background:#F4F6F1;color:#13221C;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}main{max-width:420px;background:#fff;border:1px solid #D9DFD6;border-radius:16px;padding:28px}h1{font-size:22px;margin:0 0 8px}button{font:600 15px system-ui;background:#1E5B45;color:#fff;border:0;border-radius:999px;padding:10px 18px;cursor:pointer}</style></head><body><main>${msg}</main></body></html>`;

export async function webhookRoutes(app: FastifyInstance) {
  const { db, config, providers } = app.deps;
  const now = () => app.deps.now();

  // ---- Inbound texts from Twilio: handle STOP / START and keep replies for the owner.
  app.post('/webhooks/twilio/sms', async (req, reply) => {
    const params = (req.body ?? {}) as Record<string, string>;
    if (config.TWILIO_AUTH_TOKEN) {
      const url = `${config.APP_URL.replace(/\/$/, '')}${req.url}`;
      const expected = twilioSignature(config.TWILIO_AUTH_TOKEN, url, params);
      const got = String(req.headers['x-twilio-signature'] ?? '');
      if (!got || !safeEqual(got, expected)) return reply.code(403).send('Invalid signature');
    } else if (config.NODE_ENV === 'production') {
      return reply.code(503).send('Texting is not configured');
    }

    const from = normalizePhone(params.From);
    const to = normalizePhone(params.To);
    const body = String(params.Body ?? '').trim();
    const word = body.toUpperCase().replace(/[^A-Z]/g, '');
    reply.type('text/xml');
    const empty = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
    if (!from) return empty;

    // Find matching customers: the business that owns the number they texted, or every business
    // that has this phone number when a single shared sending number is used.
    const { rows: customers } = await db.query<{ id: string; business_id: string; name: string; business_name: string; alert_email: string }>(
      `SELECT c.id, c.business_id, c.name, b.name AS business_name, COALESCE(b.reply_to_email, u.email) AS alert_email
         FROM customers c JOIN businesses b ON b.id = c.business_id JOIN users u ON u.id = b.owner_id
        WHERE c.phone = $1 AND ($2::text IS NULL OR b.sms_from = $2 OR b.sms_from IS NULL)`,
      [from, to],
    );

    for (const c of customers) {
      if (STOP_WORDS.has(word)) {
        await db.query(`UPDATE customers SET sms_opted_out_at = $2 WHERE id = $1`, [c.id, now()]);
        await stopSequences(db, c.id, 'opted_out', now());
      } else if (START_WORDS.has(word)) {
        await db.query(`UPDATE customers SET sms_opted_out_at = NULL WHERE id = $1`, [c.id]);
      } else if (body) {
        // A real reply ("booked for Thursday!", a question): pause the automatic messages so a
        // person answers, and tell the owner right away.
        await stopSequences(db, c.id, 'replied', now());
        if (providers.email && c.alert_email) {
          void providers.email.send({
            to: c.alert_email, fromName: 'One More Time',
            subject: `${c.name} replied to your text`,
            text: [
              `${c.name} replied to a message from ${c.business_name}:`, '', `"${body.slice(0, 1000)}"`, '',
              `Reply to them directly at ${from}. We've paused the automatic messages to them so you can take it from here.`, '',
              `See the conversation: ${config.APP_URL.replace(/\/$/, '')}/app#messages`,
            ].join('\n'),
          }).catch((err) => req.log.warn({ err: (err as Error).message }, 'reply alert email failed'));
        }
      }
      await db.query(
        `INSERT INTO messages (business_id, customer_id, direction, channel, to_address, body, status, provider, provider_id)
         VALUES ($1, $2, 'in', 'sms', $3, $4, 'received', 'twilio', $5)`,
        [c.business_id, c.id, to ?? '', body.slice(0, 1600), params.MessageSid ?? null],
      );
    }
    // Twilio sends the carrier-required STOP/START confirmations itself, so we reply with nothing.
    return empty;
  });

  // ---- Email unsubscribe links (and one-click unsubscribe from mail apps).
  const unsubscribe = async (token: string) => {
    const payload = verifyToken(token, config.SESSION_SECRET);
    if (!payload?.startsWith('unsub:')) return null;
    const customerId = payload.slice(6);
    const { rows } = await db.query<{ name: string }>(
      `UPDATE customers c SET email_opted_out_at = COALESCE(email_opted_out_at, $2) FROM businesses b
        WHERE c.id = $1 AND b.id = c.business_id RETURNING b.name`,
      [customerId, now()],
    );
    if (rows[0]) await stopSequences(db, customerId, 'opted_out', now());
    return rows[0]?.name ?? null;
  };

  app.get('/u/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    reply.type('text/html');
    // Show a confirm button so link scanners that pre-fetch emails don't unsubscribe people.
    return page('Unsubscribe', `<h1>Unsubscribe from these emails?</h1><p>You won't get any more reminder emails from this business.</p>
      <form method="post" action="/u/${encodeURIComponent(token)}"><button type="submit">Unsubscribe</button></form>`);
  });

  app.post('/u/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const name = await unsubscribe(token);
    reply.type('text/html');
    if (!name) return reply.code(400).send(page('Link not valid', '<h1>This link isn’t valid</h1><p>It may have been copied incompletely.</p>'));
    return page('Unsubscribed', `<h1>You're unsubscribed</h1><p>${name.replace(/[<>&"]/g, '')} won't send you any more reminder emails.</p>`);
  });

  // ---- Stripe: needs the raw body to verify the signature.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    scope.post('/webhooks/stripe', async (req, reply) => {
      if (!config.STRIPE_WEBHOOK_SECRET) return reply.code(503).send({ error: 'Billing webhooks are not configured.' });
      const raw = String(req.body ?? '');
      const sig = String(req.headers['stripe-signature'] ?? '');
      if (!verifyStripeSignature(raw, sig, config.STRIPE_WEBHOOK_SECRET)) return reply.code(400).send({ error: 'Invalid signature' });
      const result = await handleStripeEvent(db, config, JSON.parse(raw));
      return { received: true, result };
    });
  });
}
