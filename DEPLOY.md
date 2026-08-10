# Deploy the MP Models booking app

Puts the Schedule + Job Tracker online so your team can use it from any device.
The financial app is **separate** and comes later — this is the booking app only.

**Cost:** ~$5/month. **Time:** ~20–30 min. **You'll need:** your computer (has Node),
and a Railway account. Your data goes **straight from your machine to the server** —
never through GitHub.

---

## The app is already deploy-ready
- `package.json` tells the host to run `node server.js`
- `DATA_DIR` env → data lives on a persistent disk (survives restarts)
- Passwords are **hashed** (scrypt)
- Zero dependencies — nothing to install on the server

---

## Steps (Railway — friendliest)

**1. Create the account**
Go to https://railway.app → sign up (GitHub or email).

**2. Install the Railway CLI + log in** (in your Terminal)
```
npm install -g @railway/cli
railway login
```

**3. Deploy the code** (run these inside this project folder)
```
cd /Users/lissa/mpmodelsbkk
railway init          # give the project a name, e.g. mp-booking
railway up            # uploads and deploys the code
```

**4. Add a persistent disk** (Railway dashboard → your service)
- Open the service → **Volumes** → **New Volume** → mount path: `/data`

**5. Set environment variables** (dashboard → **Variables**)
- `DATA_DIR` = `/data`
- (optional) `ADMIN_PASSWORD` = a strong secret (used only when seeding new users)
- Redeploy if prompted so the volume + variables take effect.

**6. Get the public URL** (dashboard → **Settings → Networking → Generate Domain**)
You'll get something like `https://mp-booking-production.up.railway.app`.

**7. Push your current data** (one time, from your Terminal)
```
node scripts/push-to-production.js https://YOUR-APP-URL lisa@mpmodelsbkk.com 'MPdirector2026'
```
It should print: `Done: { ok: true, jobs: 414, schedule: 2367 }`.

**8. Log in & verify**
Open `https://YOUR-APP-URL/admin.html` → sign in as Director → check the jobs and
schedule are all there.

**9. (Optional) Custom domain**
Dashboard → **Settings → Networking → Custom Domain** → add `booking.mpmodelsbkk.com`
and point that DNS record where Railway tells you.

---

## After go-live
- **Change passwords for real use.** The production logins start with the same
  passwords as local (`MPdirector2026`, `admin1234`, `Tawabooker1`, …). Update
  `data/users.json` on the volume (or ask me to add a change-password screen).
- **Sessions** reset when the app redeploys — everyone just logs in again.
- **Data** lives on the `/data` volume and persists across redeploys.
- Give the team **their own logins** (Tawa / Ness / Emmy / Admin) so the Activity
  log and per-booker sales stay accurate.

## Alternative host (Render)
Same idea: create a **Web Service** from a Git repo (private), add a **Disk**
mounted at `/data`, set `DATA_DIR=/data`, then run the push script. Railway's CLI
path above avoids needing GitHub, which is why it's the recommended one.
