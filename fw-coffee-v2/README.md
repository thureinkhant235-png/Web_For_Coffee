# F & W Coffee

```
frontend/   -> Vercel  (index.html = shop, admin.html = admin panel at /admin)
backend/    -> Render  (Node.js + Express API)
database    -> Neon    (PostgreSQL; the backend creates its own tables)
```

## 1. Run locally (Node 20.6 or newer)

```bash
# terminal 1 – backend
cd backend
npm install
cp .env.example .env        # Windows: copy .env.example .env   then edit .env
npm run dev                 # API on http://localhost:4000

# terminal 2 – frontend
cd frontend
npx serve -l 3000           # shop: http://localhost:3000   admin: http://localhost:3000/admin
```

`frontend/config.js` already points at `http://localhost:4000`.

## 2. Deploy

1. **Neon** – create a project, copy the *pooled* connection string into `DATABASE_URL`.
2. **GitHub** – push this whole folder as one repository.
3. **Render** – New Web Service → pick the repo
   - Root Directory: `backend`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Environment: `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `ADMIN_EMAILS`, `ALLOWED_ORIGINS` (your Vercel URL, no trailing slash)
4. **Vercel** – New Project → pick the repo
   - Root Directory: `frontend`, Framework Preset: Other, no build command
   - Before pushing, edit `frontend/config.js`: set `window.FW_API` to your Render URL and `window.FW_GOOGLE_CLIENT_ID` to your Google client ID.
5. Admin panel: `https://your-shop.vercel.app/admin`

If you add a custom domain to Vercel, add it to `ALLOWED_ORIGINS` as well.

## 3. Google sign-in for /admin (no password)

1. https://console.cloud.google.com -> create/select a project.
2. APIs & Services -> OAuth consent screen -> User type **External** -> fill app name + your email -> Save.
   Add your Gmail under **Test users** (or press "Publish app" so it is not limited to test users).
3. APIs & Services -> Credentials -> Create credentials -> **OAuth client ID** -> Application type **Web application**.
4. **Authorized JavaScript origins** (origins only, no path, no trailing slash):
   - `http://localhost:3000`
   - `https://your-shop.vercel.app`
5. Create -> copy the **Client ID**. Put it in `backend/.env` / Render as `GOOGLE_CLIENT_ID`
   and in `frontend/config.js` as `window.FW_GOOGLE_CLIENT_ID`.
6. Set `ADMIN_EMAILS=you@gmail.com` (add more people with commas).
