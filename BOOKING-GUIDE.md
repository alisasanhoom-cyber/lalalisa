# MP Models — Booking & Job Tracker (plain-English guide)

Clients request a model on the website; the request lands in your job tracker.
Your team manages all jobs and the schedule from one dashboard — replacing the
`JOB TRACKER 2026` and `2026 SCHEDULE` spreadsheets.

## The files that make it work

| File | What it is |
|------|------------|
| `server.js` | The engine. Shows the website, receives bookings, saves data, answers the dashboard. |
| `book.html` + `js/booking.js` | The page a client fills in to request a model. |
| `admin.html` + `js/admin.js` | Your dashboard: **Job Tracker** tab + **Schedule** tab. |
| `scripts/import-excel.py` | Loads your Excel spreadsheets into the app. |

Your data lives in two plain files (this is your database):
- **`data/jobs.json`** — every job (like JOB TRACKER 2026)
- **`data/schedule.json`** — the day-by-day calendar (like 2026 SCHEDULE)

## Start it

```
node server.js
```
- **Website:** http://localhost:3000/
- **Dashboard:** http://localhost:3000/admin.html — log in with **email + password**

## Logins & access levels

There are two access levels. They live in **`data/users.json`** (change the
passwords there — one file, plain to edit).

Everyone signs in with **email + password** (so each person is identified for
the activity log).

| Who | Email | Password | Company revenue totals? |
|-----|-------|----------|-------------------------|
| **Director (you)** | lisa@mpmodelsbkk.com | `MPdirector2026` | ✅ |
| Admin (sends invoices) | admin@mpmodelsbkk.com | `admin1234` | ✅ |
| **Tawa** | mpbooker1@mpmodelsbkk.com | `Tawabooker1` | ❌ (sees own sales) |
| **Ness** | mpbooker2@mpmodelsbkk.com | `Nessbooker2` | ❌ (sees own sales) |
| **Emmy** | talents@mpmodelsbkk.com | `Emmytalents` | ❌ (sees own sales) |
| Team (shared view) | team@mpmodelsbkk.com | `mpmodels` | ❌ |

> Each booker's `bookerName` in `data/users.json` (Tawa / Ness / Emmy) must match
> the name in the job **Booker** column — that's what drives their **My sales**
> total and their name in the **Activity** log. The shared `team@` / `mpmodels`
> login is a generic view (no name, no My-sales). Change passwords in
> `data/users.json`, then restart.

## Activity log (Director / Admin only)

The **Activity** tab shows who logged in, when, and what they did — every job
created / edited / deleted and every schedule change, stamped with the person's
name and time. Filter by user or search. Bookers can't see this tab. The log is
stored in `data/activity.json` (kept out of git).

- **Director / Admin** see everything, including the **aggregate revenue split**
  (Total budget · Company/Tax · Freelance/Non-Tax) and can delete jobs.
- **Bookers** manage jobs, castings and options, fill client details, and — because
  they make the confirmations — **can see and set each job's own fee/price** so the
  confirmation prints complete. What bookers do **not** see is the **aggregate
  revenue totals** (the money measurement across all jobs), and they **cannot
  delete** jobs. Everyone sees the monthly **counts** (jobs / castings / options).

> Change passwords by editing `data/users.json`, then restart the server.
> This file is kept out of git.

## Import / refresh your spreadsheet data

```
python3 scripts/import-excel.py
```
This reads the two files in your Downloads folder and rewrites `data/jobs.json`
and `data/schedule.json`. Re-run it any time to reload from Excel.
> ⚠️ Re-importing **replaces** the data — any jobs added in the dashboard since
> the last import would be overwritten. Once you're working mainly in the
> dashboard, stop re-importing.

To point at different files:
```
python3 scripts/import-excel.py "/path/to/JOB TRACKER.xlsx" "/path/to/SCHEDULE.xlsx"
```

## What you can do in the dashboard

**Job Tracker tab**
- Pick a month, booker, or status; or search title / model / client / job ID
- See monthly totals: number of jobs, **total budget**, confirmed, pending, and how many came from the website
- Click any job to edit every field (dates, budget, job IDs, model, freelance, client, booker, status, notes)
- **+ Add job** to enter one by hand; change status right from the table
- New website requests show up highlighted with a purple **web** badge
- **Running codes:** every job added by hand automatically gets the next
  `C####` code (taxed). Inside a job you can also click **Generate C code**
  (taxed) or **Generate B code** (non-tax) — the numbers continue from your
  existing spreadsheet series.
- **Client & confirmation details:** inside each job there's a collapsible
  **Client & confirmation details** section (it opens automatically once a job is
  Confirmed). The booker fills in the client company (name, tax ID, address,
  contact), the assignment (product, role, media usage, period & country of use,
  location), and shoot schedule/fee details. Everything flows straight into the
  confirmation form, so it prints fully completed — ready to use as the
  quotation / contract. The admin then issues the invoice in your Thai
  accounting app.
  - **Shoot dates** use a click-to-pick **calendar**; **shoot times** use a
    **clock** picker.
  - Pick a **Work Package** — *Photoshoot 4h*, *Photoshoot 8h*, or
    *Video 12h (1h break)* — and the tool **calculates overtime automatically**
    from the start/end times, using your own rule (under 30 min = free,
    over 30 min = 1 hour). Enter an **Overtime Rate (THB/hour)** and it fills in
    the **Overtime Fee** and shows the full breakdown. Overnight shoots are
    handled correctly.
- **Confirmation:** open a job, pick the form type (**Tax / Non-Tax /
  International**), and click **Confirmation** to get your official confirmation
  form filled in — company letterhead, job code, client + job details, fee (with
  **7% VAT auto-calculated** on the tax forms), bank details, the full 10-point
  acknowledgement terms, and signature lines. Use **Print → Save as PDF** to send
  it. The form type defaults from the job code (C = Tax, B = Non-Tax).
  The three forms live in `js/confirmation.js` if the wording ever needs editing.

**Schedule tab**
- Pick a month, search models/notes
- Each day shows Models · Casting/Fitting · Options · Jobs (Thai text preserved)
- **+ Add entry** or delete entries

## Casting → Job (no double entry)

When a casting/option in the Schedule becomes a confirmed job, don't retype it —
click **"→ Create job"** on the entry (calendar day-popup or List view). The Add
Job form opens **pre-filled** (model, date, booker, and the casting details in
Notes, status Confirmed). The booker adds **budget + client** and clicks Create;
the job code auto-generates. The casting is then marked **"✓ Job created"** so it
can't be converted twice.

## Leads vs jobs

- **Schedule = leads** (castings / options). Each lead has a **status** you set
  right on the entry (next to the booker): **Open → Confirmed / Postponed /
  Declined**, color-coded.
- **Job Tracker = confirmed bookings.** No status column — a job in the Tracker
  is already a confirmed booking.
- A **Confirmed** lead becomes a job with the **"→ Create job"** button
  (pre-filled, one click).
- **Shortlist (red ★)** = a soft hold: the model is almost confirmed and reserved
  for that booker on that day. Add it via the red **Shortlist** button on a
  schedule entry. Opening a shortlist shows a warning — don't book that model
  elsewhere that day without checking the booker first.
- **Priority (orange ⚑)** = an admin task the model must do (visa run, work-permit
  pickup, etc.). The model is occupied that day — don't book them. Add it via the
  orange **Priority** button.

## Re-importing the schedule from the spreadsheet

`python3 scripts/import-schedule-colors.py` reloads the Schedule from
`2026 SCHEDULE.xlsx`, reading **font colours** to set each entry's booker
(blue=Tawa, green=Ness, magenta=Emmy, black=Lisa, grey=Wolf) and treating
**red text as a Shortlist**. It only touches the Schedule — never your jobs.

## The website request flow

1. A client opens a model and clicks **Book This Model** → fills the form.
2. It lands in the **Schedule as a lead (Option)** with their details in the Note —
   not as a job.
3. When it's confirmed, use **"→ Create job"** to move it into the Tracker.

## Change common things

- **Admin password** — top of `server.js`, or run: `ADMIN_PASSWORD=secret node server.js`
- **Statuses** — the `STATUSES` list at the top of `server.js`

## Good to know

- Everything runs on your computer for now — clients can't reach it yet. The
  next step is putting it online so real clients can book and the team can log
  in from anywhere.
- `data/*.json` is **not** saved to git, so real client and job data stays private.
