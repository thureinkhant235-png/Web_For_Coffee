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
   - Environment: `DATABASE_URL`, `ADMIN_PASSWORD`, `ALLOWED_ORIGINS` (your Vercel URL, no trailing slash)
4. **Vercel** – New Project → pick the repo
   - Root Directory: `frontend`, Framework Preset: Other, no build command
   - Before pushing, edit `frontend/config.js` and set `window.FW_API` to your Render URL.
5. Admin panel: `https://your-shop.vercel.app/admin`

If you add a custom domain to Vercel, add it to `ALLOWED_ORIGINS` as well.
