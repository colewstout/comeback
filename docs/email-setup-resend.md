# Turn on email with Resend

One More Time sends four kinds of email:

| Email | Goes to | Sent from |
| --- | --- | --- |
| Win-back and second-visit messages | A business's customers who don't get texts | The business's name, with replies going to the business |
| Password resets | Business owners | One More Time |
| Monday reports | Business owners | One More Time |
| Reply alerts (a customer texted back) | Business owners | One More Time |

Until email is set up, none of these are sent. The app works otherwise, and the server log shows `email: off`.

**Time:** about 20 minutes, plus up to a few hours for DNS changes to take effect.
**Cost:** free to start. Resend's free plan has included about 3,000 emails a month with a daily limit; check [resend.com/pricing](https://resend.com/pricing) for current limits before you rely on it.

## What you need first

- **Your own domain**, for example `onemoretime.app`, bought from a registrar such as Namecheap, Cloudflare, GoDaddy or Porkbun. Resend can't send from a Gmail address.
- **Access to that domain's DNS settings** at your registrar.
- **The app deployed on Render** (or wherever it runs).

## Step 1: Create a Resend account

1. Go to [resend.com](https://resend.com) and sign up.
2. Confirm your email address.

## Step 2: Add a sending domain

Use a **subdomain** just for sending, such as `mail.onemoretime.app`. This keeps your main domain's email reputation separate, and it's what Resend recommends.

1. In Resend, open **Domains → Add Domain**.
2. Enter `mail.onemoretime.app` (with your own domain).
3. Pick the region closest to your customers (**North America / us-east-1** for Dallas).
4. Resend shows a list of DNS records to add, usually:
   - an **MX** record (lets bounces come back to Resend),
   - a **TXT** record starting with `v=spf1` (says Resend may send for you),
   - a **TXT** record named like `resend._domainkey` (the DKIM signature that proves the email is really from you).

Keep this page open. You'll copy each record exactly.

## Step 3: Add the DNS records at your registrar

1. Open your domain's DNS settings at your registrar.
2. For **each** record Resend shows, add a new record with the **same type, name and value**. Copy and paste them; one wrong character breaks it.
3. Watch the **Name/Host** field. Some registrars add your domain automatically. If Resend shows `send.mail` and your registrar already appends `onemoretime.app`, enter just `send.mail`, not the full name.
4. For the MX record, set the **priority** to the number Resend shows (often 10).
5. Recommended: add a **DMARC** record so inbox providers trust you more:
   - Type: `TXT`
   - Name: `_dmarc.mail` (or `_dmarc` if you send from the root domain)
   - Value: `v=DMARC1; p=none;`
6. Save.

## Step 4: Verify the domain

1. Back in Resend, click **Verify DNS Records**.
2. It can take a few minutes to a few hours. When every record shows **Verified**, you're ready.

If a record stays pending for more than a day, compare it character by character with what Resend shows. The usual culprit is the name field (see step 3.3).

## Step 5: Create an API key

1. In Resend, open **API Keys → Create API Key**.
2. Name it `one-more-time-production`.
3. Permission: **Sending access**, limited to your sending domain.
4. Copy the key (it starts with `re_`). Resend shows it only once, so paste it into the next step right away. Don't email it or post it anywhere.

## Step 6: Add the key to Render

1. In the [Render dashboard](https://dashboard.render.com), open the **one-more-time** service, then **Environment**.
2. Set these two variables:
   - `RESEND_API_KEY`: the `re_…` key from step 5.
   - `EMAIL_FROM`: an address on your verified domain, for example `hello@mail.onemoretime.app`. It doesn't need to be a real inbox; customers' replies go to each business's own email instead.
3. Click **Save Changes**. Render redeploys automatically (a few minutes).

## Step 7: Check that it works

1. In Render, open the service's **Logs**. After the redeploy you should see a line containing `email: resend` (instead of `email: off`).
2. Open your app, log out, click **Forgot your password?**, and enter your own email. The reset email should arrive within a minute. Check spam the first time.
3. In Resend, open **Emails** (or **Logs**) to see each message and whether it was delivered.

## Before emailing real customers

- In the dashboard's **Settings**, fill in the business's **mailing address**. The law (CAN-SPAM) requires it in marketing emails, and One More Time adds it to every win-back email.
- Set **Replies to emails go to** to the business's real inbox, so customers who reply reach a person.
- Every win-back email already includes an unsubscribe link, and unsubscribes are honored automatically.

## Troubleshooting

| Problem | Likely cause | Fix |
| --- | --- | --- |
| Log still says `email: off` | One of the two variables is missing | Set both `RESEND_API_KEY` and `EMAIL_FROM`, then save |
| "Resend error 403" in the log | `EMAIL_FROM` isn't on a verified domain | Use an address on the domain verified in step 4 |
| "Resend error 401" | Wrong or deleted API key | Create a new key and update `RESEND_API_KEY` |
| Emails land in spam | New domain, no DMARC | Add the DMARC record, send a few emails to yourself, and mark them "Not spam" |
| Hitting the free plan's limit | Lots of customers on email | Upgrade in Resend; nothing changes in the app |
