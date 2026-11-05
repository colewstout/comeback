# Getting a sales export from each system

One More Time needs a business's visit history to work out each customer's rhythm. The same steps appear in the app's **Upload sales** page under "What do you use for bookings or payments?"

## What the app can read

- **One row per visit or purchase** (best): customer name (or first and last name), phone and/or email, date, amount. Optional: a status column (cancelled, no-show, void, draft and refunded rows are skipped) and a "text OK" column for customers who agreed to texts.
- **A client list** with *last visit*, *first visit* and *number of visits* (and optionally *total spend*). Visits are spread evenly between the first and last visit, which gives the right average gap. Re-uploading a newer list replaces the estimates rather than adding to them.
- Comma, tab or semicolon separated. Excel files must be saved as CSV first.
- Column names are matched flexibly. For example, "Client Name" beats "Pet Name", "Issued date" beats "Due date", and "Total" beats "Balance".

## By system

**Square.** Best: **Connect Square** in Settings, and sales sync every hour. For a file, use Dashboard → Transactions → Export → Transactions CSV. Customer names only appear on sales where a customer was attached at checkout ([Square community](https://community.squareup.com/t5/Archived-Discussions-Read-Only/How-can-you-see-the-customers-name-in-a-transaction/m-p/271074)). The customer directory export (Customers → Import/Export → Export Customers) gives totals rather than dated visits ([Square community](https://community.squareup.com/t5/Questions-How-To/Customize-reports-by-customer-name/m-p/8069)), which the app reads as a client list.

**Jobber.** Insights → Reports → **Invoice report** → Export to CSV; Jobber emails the file ([Jobber help](https://help.getjobber.com/hc/en-us/articles/17291337236247)). The client export (Clients → More Actions → Export Clients) has contacts only, no visit dates ([Jobber help](https://help.getjobber.com/en/articles/export-client-information/)).

**DaySmart Pet.** Reports tab → **Appointment Report**, which exports to Excel; save as CSV. Run large date ranges in pieces if the report times out ([MoeGo migration guide](https://help.moego.pet/en/articles/13222029-data-migration-guide-daysmart), [salonMonster guide](https://support.salonmonster.com/en/articles/10535465-moving-from-daysmart-software-to-salonmonster)). Menu names may differ by version.

**MoeGo.** Reports / Export, choosing CSV or Excel rather than PDF. Appointment statuses include Canceled and No-show, which the app skips ([GroomingOps manual](https://app.chatwoot.com/hc/groomingops-manual/articles/5-moego-orientation)). This comes from a third-party manual, not MoeGo's own docs, so confirm with MoeGo support if the menu differs.

**Gingr, Urable, Vagaro and others.** Not confirmed. Ask the company's support for: *"A CSV export of our appointment (or invoice) history for the last 12 months, with the client's name, phone, email, the date, the amount, and the appointment status."* A client list with last visit, first visit and number of visits also works.

## If a file won't import

The upload page shows which column it used for each field and the first problem row. Common fixes:

- "Could not find a date column": the file is a contact list with no visit dates. Use an appointment, invoice or transaction export, or a client list with a last-visit column.
- "This looks like an Excel file": open it and save or download as CSV.
- Customer names missing (Square): customers weren't attached to those sales. Connect Square instead, or attach customers at checkout going forward.
