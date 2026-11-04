# Comeback app

The backend and owner dashboard for Comeback: it tracks how often each customer buys, flags the ones who are overdue, and runs a three-message win-back (check-in, discount, last call) by text or email. Then it counts who came back and how much they spent.

## What's in here

| Part | Where | What it does |
| --- | --- | --- |
| Website | `public/index.html` | Marketing page with the sample-data demo. Sign-up buttons go to `/app`. |
| Dashboard | `public/app.html`, `app.js`, `app.css` | Sign up, upload sales, see who's overdue, start win-backs, read messages, change settings, choose a plan. |
| API server | `src/app.ts`, `src/routes/` | Fastify + Postgres. Accounts, imports, customers, win-backs, messages, billing, webhooks. |
| Rhythm engine | `src/lib/rhythm.ts` | Each customer's usual gap is the median time between visits. Due at 1×, overdue at 1.5× (adjustable), lapsed at 3×. |
| Win-back engine | `src/services/sequences.ts` | Starts sequences, sends steps on day 0, 7 and 21 inside sending hours, retries failures, records wins. |
| Square sync | `src/integrations/square.ts`, `src/services/squareSync.ts` | Connects a Square account (read-only), imports a year of payments, then syncs hourly. |
| Scheduler | `src/jobs/scheduler.ts` | Runs inside the server every 15 minutes: Square sync, then due messages, plus the Monday report email. |
| Database | `src/db/migrations/` | Plain SQL, applied automatically at startup. |

### How a win-back works

1. The owner uploads a CSV export (one row per purchase). Re-uploading the same file adds nothing, because every purchase has a dedupe key.
2. Each customer gets a rhythm and a status. With **autopilot** on, every overdue or lapsed customer who can be reached gets a sequence. With it off, the owner clicks **Win back**.
3. Messages go out on day 0 (no discount), day 7 (personal code like `DANA15`) and day 21 (last call), only between the business's sending hours, in its time zone.
4. Texts go only to customers with text permission who haven't replied STOP. Everyone else gets email with an unsubscribe link and the business's mailing address.
5. When a later upload shows a visit on or after the day the win-back started (or within 30 days after the last message), the sequence is marked **won** and that visit's amount counts as recovered revenue. No further messages go out.
6. A customer isn't contacted again for 90 days after a win-back starts, and customers gone more than two years are left alone.

## Run it on your computer

You need Node 22 and Postgres 16.

```bash
cd app
npm install
cp .env.example .env
createdb comeback
npm run seed
npm run dev
```

Open http://localhost:3000/app and log in as `demo@comeback.test` / `demo-password-123`. Without Twilio or Resend keys, messages print in the terminal instead of being sent.

```bash
npm test
```

The tests need a Postgres database named `comeback_test` (or set `TEST_DATABASE_URL`). They wipe that database on every run.

## Put it online

The simplest route is [Render](https://render.com): push this repo to GitHub, then **New → Blueprint** and pick the repo. `render.yaml` creates the server and a Postgres database. Expect about $7/month for the server and $6/month for the database. Set `APP_URL` to your address when Render asks.

Any host that runs Docker works the same way: build `app/Dockerfile` and give it a `DATABASE_URL`.

### Turn on email (Resend, free up to about 3,000/month)
1. Create a Resend account and verify a sending domain, such as `mail.yourdomain.com`.
2. Set `RESEND_API_KEY` and `EMAIL_FROM` (for example `hello@mail.yourdomain.com`).

### Turn on texting (Twilio)
1. Buy a toll-free number and complete **toll-free verification**, or register for A2P 10DLC. Carriers block unregistered business texting.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM_NUMBER`.
3. In the number's settings, set **A message comes in** to `https://YOUR_APP_URL/webhooks/twilio/sms` (HTTP POST). This handles STOP and START and saves replies.

### Turn on Square sync
1. Create an application at https://developer.squareup.com/apps. In **OAuth**, set the Redirect URL to `https://YOUR_APP_URL/integrations/square/callback`.
2. Set `SQUARE_APP_ID` and `SQUARE_APP_SECRET` (the OAuth "Application secret"). For testing, use the **sandbox** credentials and `SQUARE_ENVIRONMENT=sandbox`, and sign in with a sandbox test account.
3. Owners then click **Connect Square** in Settings or on the Upload page.

How it works:
- Read-only permissions: `CUSTOMERS_READ`, `PAYMENTS_READ`, `MERCHANT_PROFILE_READ`.
- The first sync imports the last 12 months of completed payments. After that, each hourly sync re-reads the last 3 days and checks the Refunds API, so refunds are applied (a fully refunded payment stops counting as a visit).
- Only payments with a customer attached at checkout can be matched to a person. Walk-in payments are counted and shown as skipped.
- Square customers are matched to existing customers by phone, then email, then name, so a business that uploaded a CSV first doesn't get duplicates.
- Square doesn't share texting permission, so Square customers start as email-only until the owner marks text permission. Customers who unsubscribed from Square emails are imported as unsubscribed.
- Tokens are encrypted in the database (AES-256-GCM) and refreshed before they expire. If an owner removes access in Square, the card shows **Reconnect Square**. Disconnecting revokes the token but keeps the imported history.

### Turn on billing (Stripe)
1. Create three products with monthly prices: Starter $49, Growth $99, Multi-location $199. Put the price IDs in `STRIPE_PRICE_*`.
2. Add a webhook endpoint `https://YOUR_APP_URL/webhooks/stripe` with the events `checkout.session.completed`, `customer.subscription.updated` and `customer.subscription.deleted`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
3. Turn on the customer portal in Stripe so owners can update cards and cancel.

New accounts get a 30-day trial. When it ends without a subscription, sending pauses but the dashboard keeps working.

## Before the first real customer

- Have a lawyer review texting consent (TCPA), your Terms of Service, and your Privacy Policy. The code enforces consent, opt-out and quiet hours, but the permission itself has to come from the business's checkout.
- Every message is recorded in the `messages` table. Keep it for your compliance records.
- Set a real `postal_address` for each business (Settings). CAN-SPAM requires it in marketing email.

## API summary

All `/api` routes need the session cookie from `/api/auth/login` or `/api/auth/signup`.

| Method | Path | |
| --- | --- | --- |
| POST | `/api/auth/signup`, `/login`, `/logout` | Accounts |
| GET | `/api/me` | User, business, plan, capabilities |
| PATCH | `/api/business` | Settings |
| GET | `/api/dashboard` | Tiles: overdue, revenue slipping, recovered |
| GET | `/api/report/weekly` | This week's report |
| POST | `/api/imports` | `{ filename, csv, smsConsentAll }` |
| GET | `/api/customers?status=` | `all, attention, due, overdue, lapsed, in_progress, won, ok` |
| GET, PATCH | `/api/customers/:id` | Detail with visits, messages and a message preview; edit contact |
| POST | `/api/customers/:id/winback`, `/stop`, `/opt-out` | Control win-backs |
| GET | `/api/messages` | Last 100 messages and replies |
| POST | `/api/billing/checkout`, `/portal` | Stripe |
| POST | `/webhooks/twilio/sms`, `/webhooks/stripe` | Signed webhooks |
| GET, POST | `/u/:token` | Email unsubscribe |
| GET | `/api/integrations` | Square connection status |
| POST | `/api/integrations/square/sync`, `/disconnect` | Sync now; disconnect |
| GET | `/integrations/square/connect`, `/callback` | Square OAuth (browser redirects) |
| POST | `/jobs/tick`, `/jobs/weekly-report` | For external cron. `Authorization: Bearer $CRON_SECRET` |

## Next features worth building

1. Square webhooks (`payment.updated`) for real-time sync instead of hourly, and applying the Square sync to multiple locations separately.
2. Password reset by email. Not built yet. For now, reset a password by hand in the database.
3. "First visit to second visit" sequence for brand-new customers.
4. Two-way texting: forward customer replies to the owner's phone.
5. Discount code redemption entry at checkout (today a return visit counts as the win).
