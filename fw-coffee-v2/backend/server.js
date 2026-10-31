"use strict";
/* F & W Coffee – backend (Node.js + Express + PostgreSQL / Neon)
   - Creates and migrates its own tables automatically on every start (no manual SQL).
   - Pure JSON API. The website + admin panel are hosted separately (Vercel).

   Environment variables
     DATABASE_URL    (required)  Neon connection string (use the "pooled" one)
     GOOGLE_CLIENT_ID (required) OAuth client ID from Google Cloud (see README)
     ADMIN_EMAILS    (required)  comma-separated Google accounts allowed into /admin
     ALLOWED_ORIGINS (required)  comma-separated website URLs allowed to call this API,
                                 e.g. https://my-shop.vercel.app,http://localhost:3000
     PORT            (optional)  Render sets this automatically
     LOW_STOCK       (optional)  stock level flagged as "low" in admin (default 10)      */

const express = require("express");
const { Pool, types } = require("pg");
const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");

types.setTypeParser(20, Number); // bigint (COUNT, SUM, total) -> JS number

const PORT = Number(process.env.PORT) || 4000;
const DATABASE_URL = process.env.DATABASE_URL || "";
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);
const lowParsed = parseInt(process.env.LOW_STOCK, 10);
const LOW_STOCK = Number.isInteger(lowParsed) && lowParsed >= 0 ? lowParsed : 10;
const IK_PUBLIC_KEY = (process.env.IMAGEKIT_PUBLIC_KEY || "").trim();
const IK_PRIVATE_KEY = (process.env.IMAGEKIT_PRIVATE_KEY || "").trim();
const IK_URL_ENDPOINT = (process.env.IMAGEKIT_URL_ENDPOINT || "").trim().replace(/\/+$/, "");
if (!IK_PUBLIC_KEY || !IK_PRIVATE_KEY || !IK_URL_ENDPOINT)
  console.warn("WARNING: ImageKit variables are not set – product image upload is disabled.");
if (!DATABASE_URL) { console.error("ERROR: set DATABASE_URL (your Neon connection string)."); process.exit(1); }
if (!GOOGLE_CLIENT_ID) { console.error("ERROR: set GOOGLE_CLIENT_ID (see README, Google sign-in)."); process.exit(1); }
if (!ADMIN_EMAILS.length) { console.error("ERROR: set ADMIN_EMAILS (the Google accounts allowed into the admin panel)."); process.exit(1); }
if (!ORIGINS.length) console.warn("WARNING: ALLOWED_ORIGINS is empty – browsers on other domains will be blocked.");

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------- Database ---------- */
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000 // Neon may need a few seconds to wake up
});
pool.on("error", e => console.error("DB pool error:", e.message));
const query = (text, params) => pool.query(text, params);

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { c.release(); }
}

// To change the database in future, ADD a new entry at the end. Never edit old ones.
const MIGRATIONS = [
  `CREATE TABLE products(
     id SERIAL PRIMARY KEY,
     name TEXT NOT NULL,
     descr TEXT NOT NULL DEFAULT '',
     price INTEGER NOT NULL CHECK (price >= 0),
     stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
     active BOOLEAN NOT NULL DEFAULT TRUE,
     c1 TEXT NOT NULL DEFAULT '#7a3f1d',
     c2 TEXT NOT NULL DEFAULT '#e0a648',
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE TABLE orders(
     id SERIAL PRIMARY KEY,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     name TEXT NOT NULL,
     phone TEXT NOT NULL,
     addr TEXT NOT NULL,
     pay TEXT NOT NULL,
     items JSONB NOT NULL,
     total BIGINT NOT NULL,
     status TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New','Confirmed','Delivered','Cancelled')),
     note TEXT NOT NULL DEFAULT ''
   );
   CREATE INDEX idx_orders_created ON orders(created_at DESC);
   CREATE INDEX idx_orders_status ON orders(status);
   CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);`,

  // Starting products (only if the table is still empty).
  `INSERT INTO products(name,descr,price,stock,c1,c2)
   SELECT v.* FROM (VALUES
     ('Mr Viet Ground Coffee – Good Morning','နံနက်ခင်းအတွက် ညီညာသော အရသာ၊ ဖင်ဖစ်တာအတွက် ကြိတ်ပြီးသား (၅၀၀ ဂရမ်)',14000,50,'#7a3f1d','#e0a648'),
     ('Mr Viet Ground Coffee – Dalat Blend','ဒါလတ်ကုန်းမြင့်မှ ရွေးထားသော ရောစပ်ကော်ဖီ၊ ရနံ့မွှေးပြီး ကိုယ်ထည်ပြည့်ဝ (၅၀၀ ဂရမ်)',17000,50,'#3d2214','#c98a2b'),
     ('Mr Viet Whole Bean – Arabica / Robusta','ကော်ဖီစေ့အပြည့်၊ ကိုယ်တိုင်ကြိတ်သောက်ရန် (၁ ကီလို)',32000,50,'#2a1710','#b8742e'),
     ('Mr Viet 3-in-1 Instant Coffee','ကော်ဖီ၊ ဆီးနှင့် သကြား ပါပြီးသား၊ ရေနွေးထည့်ရုံဖြင့် အဆင်သင့် (၂၀ ဆာချေ)',9000,50,'#a8541c','#f3c77a')
   ) AS v(name,descr,price,stock,c1,c2)
   WHERE NOT EXISTS (SELECT 1 FROM products);`,

  // Product photos live at ImageKit; the database keeps only the link and ImageKit's file id.
  `ALTER TABLE products
     ADD COLUMN image_url TEXT,
     ADD COLUMN image_file_id TEXT;`,

  // Secret code so each customer can open only their own invoice.
  `ALTER TABLE orders
     ADD COLUMN public_token TEXT NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '');`
];

async function migrate() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(727274)"); // one instance migrates at a time
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const { rows } = await c.query("SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations");
    for (let v = rows[0].v; v < MIGRATIONS.length; v++) {
      await c.query(MIGRATIONS[v]);
      await c.query("INSERT INTO schema_migrations(version) VALUES($1)", [v + 1]);
      console.log(`Applied migration ${v + 1}`);
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { c.release(); }
}

// Secret used to sign admin login tokens. Created once and kept in the database.
let SECRET = "";
async function loadSecret() {
  await query("INSERT INTO settings(key,value) VALUES('secret',$1) ON CONFLICT (key) DO NOTHING",
    [crypto.randomBytes(32).toString("hex")]);
  SECRET = (await query("SELECT value FROM settings WHERE key='secret'")).rows[0].value;
}

/* ---------- Helpers ---------- */
const STATUSES = ["New", "Confirmed", "Delivered", "Cancelled"];
const COLOR = /^#[0-9a-fA-F]{6}$/;
const sign = d => crypto.createHmac("sha256", SECRET).update(d).digest("base64url");

// Our own 12-hour session token, issued only after Google has confirmed who you are.
function makeToken(email) {
  const body = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 3600 * 1000, email })).toString("base64url");
  return body + "." + sign(body);
}
function validToken(tok) {
  if (!tok) return false;
  const [body, sig] = tok.split(".");
  if (!body || !sig) return false;
  const expect = sign(body);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    // Removing an email from ADMIN_EMAILS locks that person out immediately.
    return p.exp > Date.now() && ADMIN_EMAILS.includes(p.email);
  } catch { return false; }
}
const bearer = req => { const h = req.headers.authorization || ""; return h.startsWith("Bearer ") ? h.slice(7) : ""; };
const isAdmin = req => validToken(bearer(req));
const requireAdmin = (req, res, next) =>
  isAdmin(req) ? next() : res.status(401).json({ error: "Not logged in" });

function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.reset < n) hits.delete(k); }, 60000).unref();
  return (req, res, next) => {
    const now = Date.now();
    let h = hits.get(req.ip);
    if (!h || h.reset < now) { h = { count: 0, reset: now + windowMs }; hits.set(req.ip, h); }
    if (++h.count > max) return res.status(429).json({ error: "Too many requests. Please try again later." });
    next();
  };
}
const str = (v, min, max, label) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length < min || s.length > max) throw new HttpError(400, `${label} is invalid`);
  return s;
};
const int = (v, min, max, label) => {
  const n = Number(v);
  if (v === null || v === "" || typeof v === "boolean" || !Number.isInteger(n) || n < min || n > max)
    throw new HttpError(400, `${label} must be a whole number between ${min} and ${max}`);
  return n;
};
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).then(d => res.json(d)).catch(next);

/* ---------- Database actions ---------- */
async function placeOrder(o) {
  return tx(async c => {
    const bought = new Map();
    // Sorted by id so two simultaneous orders can never deadlock.
    for (const it of [...o.items].sort((a, b) => a.id - b.id)) {
      const r = await c.query(
        `UPDATE products SET stock = stock - $1, updated_at = now()
         WHERE id = $2 AND active AND stock >= $1 RETURNING name, price`, [it.qty, it.id]);
      if (!r.rowCount) {
        const p = (await c.query("SELECT name, active, stock FROM products WHERE id=$1", [it.id])).rows[0];
        if (!p || !p.active) throw new HttpError(409, "Item no longer available");
        throw new HttpError(409, `Not enough stock: ${p.name} (${p.stock} left)`);
      }
      bought.set(it.id, { id: it.id, name: r.rows[0].name, qty: it.qty, price: r.rows[0].price });
    }
    const lines = o.items.map(i => bought.get(i.id));
    const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
    const r = await c.query(
      "INSERT INTO orders(name,phone,addr,pay,items,total) VALUES($1,$2,$3,$4,$5,$6) RETURNING id, public_token",
      [o.name, o.phone, o.addr, o.pay, JSON.stringify(lines), total]);
        return { id: r.rows[0].id, total, token: r.rows[0].public_token };
  });
}

// Cancelling an order puts the stock back. Re-opening it takes the stock again.
async function changeStatus(id, status) {
  return tx(async c => {
    const o = (await c.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!o) throw new HttpError(404, "Order not found");
    const items = [...o.items].sort((a, b) => a.id - b.id);
    if (status === "Cancelled" && o.status !== "Cancelled")
      for (const i of items)
        await c.query("UPDATE products SET stock = stock + $1, updated_at = now() WHERE id = $2", [i.qty, i.id]);
    if (o.status === "Cancelled" && status !== "Cancelled")
      for (const i of items) {
        const r = await c.query(
          "UPDATE products SET stock = stock - $1, updated_at = now() WHERE id = $2 AND stock >= $1", [i.qty, i.id]);
        if (!r.rowCount) throw new HttpError(409, `Not enough stock of "${i.name}" to re-open this order`);
      }
    await c.query("UPDATE orders SET status=$1 WHERE id=$2", [status, id]);
  });
}

/* Validates a product body. `base` supplies defaults when editing. */
function productFields(b, base = {}) {
  const pick = (k, d) => (b[k] === undefined ? base[k] ?? d : b[k]);
  const c1 = pick("c1", "#7a3f1d"), c2 = pick("c2", "#e0a648");
  if (!COLOR.test(c1) || !COLOR.test(c2)) throw new HttpError(400, "Colour must look like #7a3f1d");
  const a = pick("active", true);
  return {
    name: str(pick("name"), 1, 150, "Name"),
    descr: String(pick("descr", "")).trim().slice(0, 500),
    price: int(pick("price"), 0, 1e9, "Price"),
    stock: int(pick("stock"), 0, 1e6, "Stock"),
    active: a === true || a === 1 || a === "1" || a === "true",
    c1, c2
  };
}

const csvCell = (v, guard = true) => {
  let s = String(v ?? "");
  if (guard && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // stops spreadsheet formula injection
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/* ---------- App ---------- */
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.set({
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Max-Age": "600"
    });
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "50kb" }));
app.use("/api", (req, res, next) => {
  if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method) && !req.is("application/json"))
    return res.status(415).json({ error: "Send JSON" });
  next();
});

app.get("/", (req, res) => res.send("F & W Coffee API"));
app.get("/healthz", wrap(async () => { await query("SELECT 1"); return { ok: true }; }));

// ----- Public API -----
app.get("/api/products", wrap(async () =>
  (await query("SELECT id,name,descr,price,stock,c1,c2,image_url FROM products WHERE active ORDER BY id")).rows
));

app.post("/api/orders", limiter(20, 3600 * 1000), wrap(async req => {
  const b = req.body || {};
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 30) throw new HttpError(400, "Cart is empty");
  const merged = new Map();
  for (const it of b.items) {
    const id = int(it && it.id, 1, 2147483647, "Item"), qty = int(it && it.qty, 1, 99, "Quantity");
    merged.set(id, (merged.get(id) || 0) + qty);
  }
  const items = [...merged].map(([id, qty]) => ({ id, qty }));
  if (items.some(i => i.qty > 99)) throw new HttpError(400, "Quantity too large");
  return placeOrder({
    name: str(b.name, 1, 100, "Name"),
    phone: str(b.phone, 5, 40, "Phone"),
    addr: str(b.addr, 1, 500, "Address"),
    pay: str(b.pay, 1, 80, "Payment"),
    items
  });
}));
// ----- Public: invoice (needs the secret code from the invoice link) -----
app.get("/api/orders/:id", limiter(60, 3600 * 1000), wrap(async req => {
  const id = int(req.params.id, 1, 2147483647, "Order id");
  const t = typeof req.query.t === "string" ? req.query.t : "";
  const o = (await query(
    "SELECT id,created_at,name,phone,addr,pay,items,total,status FROM orders WHERE id=$1 AND public_token=$2",
    [id, t])).rows[0];
  if (!o) throw new HttpError(404, "Invoice not found");
  return o;
}));
// ----- Admin auth (Bearer token; the website keeps it in sessionStorage) -----
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
app.post("/api/admin/login", limiter(20, 15 * 60 * 1000), async (req, res, next) => {
  try {
    const cred = req.body && req.body.credential;
    if (typeof cred !== "string" || !cred || cred.length > 4096)
      return res.status(400).json({ error: "Missing Google credential" });
    let p;
    try {
      const t = await googleClient.verifyIdToken({ idToken: cred, audience: GOOGLE_CLIENT_ID });
      p = t.getPayload();
    } catch { return res.status(401).json({ error: "Google sign-in could not be verified" }); }
    const email = String(p.email || "").toLowerCase();
    if (!p.email_verified || !ADMIN_EMAILS.includes(email))
      return res.status(403).json({ error: `${email || "This account"} is not allowed to use the admin panel` });
    res.json({ token: makeToken(email), email });
  } catch (e) { next(e); }
});
app.get("/api/admin/me", (req, res) => res.json({ admin: isAdmin(req) }));

// ----- Admin: dashboard numbers -----
app.get("/api/admin/stats", requireAdmin, wrap(async () => {
  const [byStatus, all, today, low] = await Promise.all([
    query("SELECT status, COUNT(*) AS n FROM orders GROUP BY status"),
    query("SELECT COALESCE(SUM(total),0)::bigint AS s FROM orders WHERE status <> 'Cancelled'"),
    query(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0)::bigint AS s FROM orders
           WHERE status <> 'Cancelled'
             AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Yangon') AT TIME ZONE 'Asia/Yangon')`),
    query("SELECT COUNT(*) AS n FROM products WHERE active AND stock <= $1", [LOW_STOCK])
  ]);
  const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
  for (const r of byStatus.rows) counts[r.status] = r.n;
  return {
    counts, revenue: all.rows[0].s,
    todayOrders: today.rows[0].n, todayRevenue: today.rows[0].s,
    lowStock: low.rows[0].n, lowStockLevel: LOW_STOCK
  };
}));

// ----- Admin: orders -----
app.get("/api/admin/orders", requireAdmin, wrap(async req => {
  const where = [], args = [];
  const add = v => (args.push(v), "$" + args.length);
  if (STATUSES.includes(req.query.status)) where.push(`status = ${add(req.query.status)}`);
  const term = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  if (term) {
    const like = add("%" + term.replace(/[\\%_]/g, "\\$&") + "%");
    const idm = add(term.replace(/^#/, ""));
    where.push(`(name ILIKE ${like} OR phone ILIKE ${like} OR addr ILIKE ${like} OR id::text = ${idm})`);
  }
  const clause = where.length ? "WHERE " + where.join(" AND ") : "";
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const total = (await query(`SELECT COUNT(*) AS n FROM orders ${clause}`, args)).rows[0].n;
  const rows = (await query(
    `SELECT * FROM orders ${clause} ORDER BY id DESC LIMIT ${add(limit)} OFFSET ${add(offset)}`, args)).rows;
  return { rows, total };
}));

app.get("/api/admin/orders.csv", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await query("SELECT * FROM orders ORDER BY id DESC");
    const head = ["Order", "Date (UTC)", "Name", "Phone", "Address", "Payment", "Items", "Total (Ks)", "Status", "Note"];
    const lines = [head.join(",")].concat(rows.map(o => [
      o.id, o.created_at.toISOString(), csvCell(o.name), csvCell(o.phone, false), csvCell(o.addr), csvCell(o.pay),
      csvCell(o.items.map(i => `${i.name} x${i.qty}`).join("; ")), o.total, o.status, csvCell(o.note)
    ].map(x => (typeof x === "string" ? x : csvCell(x, false))).join(",")));
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`
    });
    res.send("﻿" + lines.join("\r\n")); // BOM so Excel reads Myanmar text correctly
  } catch (e) { next(e); }
});

app.patch("/api/admin/orders/:id", requireAdmin, wrap(async req => {
  const id = int(req.params.id, 1, 2147483647, "Order id");
  const b = req.body || {};
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) throw new HttpError(400, "Invalid status");
    await changeStatus(id, b.status);
  }
  if (b.note !== undefined) {
    const r = await query("UPDATE orders SET note=$1 WHERE id=$2", [String(b.note).trim().slice(0, 500), id]);
    if (!r.rowCount) throw new HttpError(404, "Order not found");
  }
  return { ok: true };
}));

// ----- Admin: inventory -----
app.get("/api/admin/products", requireAdmin, wrap(async () =>
  (await query("SELECT * FROM products ORDER BY id")).rows
));
app.post("/api/admin/products", requireAdmin, wrap(async req => {
  const f = productFields(req.body || {});
  const r = await query(
    "INSERT INTO products(name,descr,price,stock,active,c1,c2) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
    [f.name, f.descr, f.price, f.stock, f.active, f.c1, f.c2]);
  return { id: r.rows[0].id };
}));
app.patch("/api/admin/products/:id", requireAdmin, wrap(async req => {
  const id = int(req.params.id, 1, 2147483647, "Product id");
  return tx(async c => {
    const cur = (await c.query("SELECT * FROM products WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!cur) throw new HttpError(404, "Product not found");
    const b = { ...(req.body || {}) };
    // "delta" adjusts stock relative to the live value (safe while orders arrive).
    if (b.delta !== undefined) b.stock = cur.stock + int(b.delta, -1e6, 1e6, "Stock change");
    const f = productFields(b, cur);
    await c.query(
      "UPDATE products SET name=$1,descr=$2,price=$3,stock=$4,active=$5,c1=$6,c2=$7,updated_at=now() WHERE id=$8",
      [f.name, f.descr, f.price, f.stock, f.active, f.c1, f.c2, id]);
    return { ok: true, stock: f.stock };
  });
}));

// ----- Admin: product photos (stored at ImageKit; the database keeps only the link) -----
const needIK = () => {
  if (!IK_PUBLIC_KEY || !IK_PRIVATE_KEY || !IK_URL_ENDPOINT)
    throw new HttpError(503, "Image upload is not set up yet (ImageKit keys are missing on the server)");
};
async function ikDelete(fileId) { // best effort: remove the replaced/removed file from ImageKit
  if (!fileId || !IK_PRIVATE_KEY) return;
  try {
    await fetch(`https://api.imagekit.io/v1/files/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
      headers: { Authorization: "Basic " + Buffer.from(IK_PRIVATE_KEY + ":").toString("base64") }
    });
  } catch (e) { console.error("ImageKit delete failed:", e.message); }
}

// The browser uploads straight to ImageKit; this only hands it a short-lived signed permission.
app.get("/api/admin/imagekit-auth", requireAdmin, wrap(async () => {
  needIK();
  const token = crypto.randomUUID();
  const expire = Math.floor(Date.now() / 1000) + 30 * 60;
  const signature = crypto.createHmac("sha1", IK_PRIVATE_KEY).update(token + expire).digest("hex");
  return { token, expire, signature, publicKey: IK_PUBLIC_KEY, folder: "/fw-coffee" };
}));

app.put("/api/admin/products/:id/image", requireAdmin, wrap(async req => {
  needIK();
  const id = int(req.params.id, 1, 2147483647, "Product id");
  const url = str(req.body && req.body.url, 10, 500, "Image link");
  const fileId = str(req.body && req.body.fileId, 1, 100, "File id");
  if (!url.startsWith(IK_URL_ENDPOINT + "/")) throw new HttpError(400, "Image must be hosted on your ImageKit account");
  const old = await tx(async c => {
    const cur = (await c.query("SELECT image_file_id FROM products WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!cur) throw new HttpError(404, "Product not found");
    await c.query("UPDATE products SET image_url=$1, image_file_id=$2, updated_at=now() WHERE id=$3", [url, fileId, id]);
    return cur.image_file_id;
  });
  if (old && old !== fileId) ikDelete(old);
  return { ok: true, image_url: url };
}));

app.delete("/api/admin/products/:id/image", requireAdmin, wrap(async req => {
  const id = int(req.params.id, 1, 2147483647, "Product id");
  const old = await tx(async c => {
    const cur = (await c.query("SELECT image_file_id FROM products WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!cur) throw new HttpError(404, "Product not found");
    await c.query("UPDATE products SET image_url=NULL, image_file_id=NULL, updated_at=now() WHERE id=$1", [id]);
    return cur.image_file_id;
  });
  ikDelete(old);
  return { ok: true };
}));

app.use((req, res) => res.status(404).json({ error: "Not found" }));

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === "entity.parse.failed" || err.type === "entity.too.large")
    return res.status(400).json({ error: "Bad request" });
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

/* ---------- Start ---------- */
(async () => {
  try {
    await migrate();
    await loadSecret();
  } catch (e) {
    console.error("Startup failed:", e);
    process.exit(1);
  }
  const server = app.listen(PORT, () => console.log(`F & W Coffee API running on port ${PORT}`));
  for (const sig of ["SIGINT", "SIGTERM"])
    process.on(sig, () => server.close(() => pool.end().finally(() => process.exit(0))));
})();
