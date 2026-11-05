# Turn on texting with Twilio

Texts get far more replies than email, but phone carriers only deliver business texts from **verified** numbers. Verification takes days to weeks, so **start early**, ideally while your first pilot is still on email.

Until texting is set up, the app sends win-backs by email and the server log shows `texting: off`. A business without its own verified number also stays on email, so nothing breaks while you wait.

## How it fits together

- **Each business texts from its own toll-free number**, verified with *that business's* details. Twilio warns against one number sending for several businesses ([Twilio ISV guidance](https://www.twilio.com/docs/sms/a2p-10dlc/onboarding-isv)), and customers should see texts coming from the shop they know.
- **Unverified toll-free numbers can't text anyone** in the US or Canada ([Twilio](https://www.twilio.com/docs/messaging/compliance/toll-free/console-onboarding)).
- Toll-free numbers are the simplest route for a small sender. The other route (A2P 10DLC, regular local numbers) needs brand and campaign registration for every business. Consider it later if you outgrow toll-free.

## What each business must give you

Verification is in the business's name, so collect this during setup:

- Legal business name and address exactly as registered.
- **EIN** (federal tax ID). Since February 17, 2026, toll-free verification requires a business registration number for every business type except sole proprietorships ([Twilio changelog](https://www.twilio.com/en-us/changelog/business-registration-numbers-required-for-toll-free-messaging-p)). For US businesses that's the EIN, and it must match the legal name.
- Website.
- A contact person's name, email and phone.
- **How customers agree to texts**, with proof. For example: a photo of the sign at checkout, a screenshot of the booking form's "text me" checkbox, or the consent form clients sign. Reviewers check that the opt-in really exists and isn't forced.

If the business doesn't collect text permission yet, give them this wording for a checkout sign, intake form or booking page:

> Text me appointment reminders and offers from [Business]. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent isn't a condition of purchase.

## Step 1: Your Twilio account (once)

1. Sign up at [twilio.com](https://www.twilio.com).
2. **Upgrade from the trial** by adding a payment method. Trial accounts can only text numbers you've verified yourself and add a "trial account" prefix.
3. From the Console home page, copy your **Account SID** and **Auth Token**. Treat the token like a password.

## Step 2: Buy a toll-free number for the business

1. Console → **Phone Numbers → Buy a number**.
2. Choose **Toll-free** with **SMS** capability and buy one. Check [twilio.com/sms/pricing/us](https://www.twilio.com/en-us/sms/pricing/us) for the current number and per-message prices.
3. Open the number's settings. Under **Messaging → A message comes in**, choose **Webhook**, enter `https://YOUR-APP-ADDRESS/webhooks/twilio/sms` and **HTTP POST**, then save. (Your app address is the `onrender.com` address, or your custom domain.) This is how STOP, START and customer replies reach One More Time.

## Step 3: Submit toll-free verification

In the Console, open the number's toll-free verification form (Twilio's [console onboarding guide](https://www.twilio.com/docs/messaging/compliance/toll-free/console-onboarding) walks through each screen). Fill it in with **the business's** details from above, plus:

- **Use case:** marketing or promotional messages to existing customers (win-back reminders and offers).
- **Estimated monthly volume:** for a small shop, the lowest band is usually right.
- **Opt-in type and proof:** how customers agree (point of sale, paper form, web form) and a **publicly accessible** link or image showing it. No logins.
- **Privacy Policy and Terms URLs:** required on new submissions since September 15, 2026 ([Twilio changelog](https://www.twilio.com/en-us/changelog/toll-free-verification-now-requires-privacy-policy-and-terms-and)). They must mention message frequency, message and data rates, HELP and STOP, and that opt-in consent isn't shared for marketing. Use the business's own pages if it has them. One More Time's `/privacy.html` and `/terms.html` cover how messages are handled; ask Twilio support if you're unsure which they want.
- **Sample messages:** paste two real ones, for example:
  - `Hi Dana, it's Sudsy Paws. It's been about 9 weeks since Biscuit's last groom. Want us to save you a spot this week? Reply STOP to opt out.`
  - `Hi Dana, we'd love to see you again! Here's 15% off your next groom before Dec 2. Use code DANA15. Reply STOP to opt out.`

Submit, then wait for approval. Reports range from a few business days to a few weeks. If it's rejected, the email says why; fix that one thing and resubmit.

## Step 4: Connect Twilio to the app (once)

1. In Render, open the **one-more-time** service → **Environment**.
2. Add `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` from step 1.
3. Leave `TWILIO_FROM_NUMBER` **empty**, so each business uses its own number.
4. Save. Render redeploys, and the log should show `texting: twilio`.

## Step 5: Assign the number to the business

1. Log in to One More Time with your admin email and open the **Admin** tab.
2. Under **Businesses**, find the shop and click **Set number** in the *Texting number* column.
3. Enter the verified toll-free number and save.

From then on, that business's customers who agreed to texts get texts; everyone else still gets email.

## Step 6: Test before customers see it

1. In the business's dashboard, upload a tiny file with yourself as a customer (your mobile, a visit about 3 months ago, `yes` in a "text OK" column).
2. Open yourself in the customer list and click **Start win-back**. The first text should arrive within a minute (inside sending hours).
3. Reply `STOP`. Your customer record should show you opted out.
4. Reply `START`, then send a normal reply like "Thursday works". The business owner gets a reply-alert email, and your win-back pauses.

## Troubleshooting

| What you see | Likely cause | Fix |
| --- | --- | --- |
| Log says `texting: off` | Account SID or Auth Token missing | Add both in Render and save |
| A business's customers only get email | No number assigned, or the plan doesn't include texting (Starter is email-only) | Set the number in Admin, or move them to Growth |
| Messages fail with a Twilio error about the number not being verified | Verification still pending or rejected | Check the verification status in the Console |
| Error 21610 | The customer replied STOP earlier | Nothing to fix. They only receive texts again if they reply START |
| STOP replies don't register | Webhook URL wrong or not HTTP POST | Re-check step 2.3, using the exact app address |
| Replies are rejected with "Invalid signature" | The app's address doesn't match what Twilio called | Set `APP_URL` in Render to the exact address in the webhook |
