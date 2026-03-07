require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { Pool }= require('pg');

const app  = express();
const PORT = process.env.PORT || 3001;
const JWT  = process.env.JWT_SECRET || 'africhic_secret_2025';

// ── DATABASE (SSL fix + keepalive)
const _db = process.env.DATABASE_URL || '';
const DB_URL = _db.includes('uselibpqcompat') ? _db
  : _db + (_db.includes('?') ? '&' : '?') + 'uselibpqcompat=true&sslmode=require';
const pool = new Pool({ connectionString: DB_URL, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
pool.query('SELECT 1').then(() => console.log('✅ DB connected')).catch(e => console.error('DB error:', e.message));
setInterval(() => pool.query('SELECT 1').catch(() => {}), 4 * 60 * 1000);


// ── EMAIL NOTIFICATIONS (Nodemailer — set SMTP_* env vars in Railway)
let transporter = null;
try {
  const nodemailer = require('nodemailer');
  if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT)||587,
      secure: process.env.SMTP_SECURE==='true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    console.log('✅ Email configured via', process.env.SMTP_HOST);
  } else {
    console.log('⚠️  No SMTP config — emails disabled. Set SMTP_HOST, SMTP_USER, SMTP_PASS in Railway env.');
  }
} catch(e) { console.log('⚠️  nodemailer not installed — run: npm install nodemailer'); }

const STORE_EMAIL = process.env.STORE_EMAIL || 'admin@africhic.co.za';
const STORE_NAME  = 'Africhic Garments';
const SITE_URL    = process.env.SITE_URL || 'https://africhicgarmentshoponline.netlify.app';

const STATUS_SUBJECT = {
  pending:    '✦ Order Received — {num}',
  processing: '📦 Order Being Prepared — {num}',
  shipped:    '🚚 Your Order is On Its Way — {num}',
  delivered:  '✅ Order Delivered — {num}',
  cancelled:  'Order Cancelled — {num}'
};

function emailTemplate(title, body, orderNum, trackingNum) {
  const trackLink = `${SITE_URL}/track.html?order=${orderNum}`;
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>body{margin:0;padding:0;background:#f5f0e8;font-family:'Helvetica Neue',Arial,sans-serif}
.wrap{max-width:560px;margin:30px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)}
.hdr{background:#3d2b1f;padding:28px 32px;text-align:center}
.hdr h1{color:#fff;font-size:1.5rem;font-weight:300;margin:0;letter-spacing:.05em}
.hdr p{color:rgba(255,255,255,.6);font-size:.75rem;margin:4px 0 0;letter-spacing:.15em;text-transform:uppercase}
.body{padding:32px}
.body h2{font-size:1.2rem;font-weight:400;color:#3d2b1f;margin:0 0 14px}
.body p{font-size:.88rem;line-height:1.7;color:#5a4238;margin:0 0 14px}
.status-chip{display:inline-block;padding:6px 18px;border-radius:20px;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:18px}
.msg-box{background:#f5f0e8;border-radius:8px;padding:16px 18px;border-left:3px solid #8b5a32;margin:16px 0}
.msg-box p{margin:0;font-size:.86rem;color:#3d2b1f}
.track-btn{display:block;background:#8b5a32;color:#fff !important;text-decoration:none;text-align:center;padding:14px 28px;border-radius:5px;font-size:.82rem;font-weight:500;letter-spacing:.1em;text-transform:uppercase;margin:20px 0}
.track-btn:hover{background:#7a4e2c}
${trackingNum?`.tn-box{background:#e8f5e9;border-radius:8px;padding:14px 18px;text-align:center;margin:14px 0}
.tn-box p{margin:0;font-size:.8rem;color:#2e7d32}
.tn-box strong{font-size:1.1rem;display:block;color:#1b5e20;letter-spacing:.1em}`:''}
.ftr{background:#f5f0e8;padding:20px 32px;text-align:center;border-top:1px solid #e8ddd0}
.ftr p{font-size:.74rem;color:#9a8070;margin:3px 0;line-height:1.6}
</style></head>
<body><div class="wrap">
<div class="hdr"><h1>Afri<em>chic</em></h1><p>Garments</p></div>
<div class="body">
<h2>${title}</h2>
${body}
${trackingNum?`<div class="tn-box"><p>Your Tracking Number</p><strong>${trackingNum}</strong>${process.env.COURIER_TRACK_URL?`<p style="margin:6px 0 0"><a href="${process.env.COURIER_TRACK_URL}${trackingNum}" style="color:#2e7d32;font-size:.78rem">Track with courier →</a></p>`:''}</div>`:''}
<a href="${trackLink}" class="track-btn">View Order Status →</a>
</div>
<div class="ftr">
<p><strong>${STORE_NAME}</strong></p>
<p>Questions? Reply to this email or visit <a href="${SITE_URL}" style="color:#8b5a32">${SITE_URL}</a></p>
<p style="margin-top:8px;font-size:.68rem;color:#b0967e">You're receiving this because you placed an order with us.</p>
</div>
</div></body></html>`;
}

async function sendOrderEmail(to, subject, htmlBody) {
  if (!transporter || !to) return;
  try {
    await transporter.sendMail({
      from: `"${STORE_NAME}" <${STORE_EMAIL}>`,
      to,
      subject,
      html: htmlBody
    });
    console.log('📧 Email sent to', to, '—', subject);
  } catch(e) { console.error('📧 Email failed:', e.message); }
}

async function sendAdminAlert(subject, html) {
  if (!transporter) return;
  try {
    await transporter.sendMail({
      from: `"${STORE_NAME}" <${STORE_EMAIL}>`,
      to: STORE_EMAIL,
      subject: '[ADMIN] ' + subject,
      html
    });
  } catch(e) { console.error('📧 Admin alert failed:', e.message); }
}

// Auto-generate courier tracking number
function genTrackingNum() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let n = 'AFC';
  for (let i=0;i<8;i++) n += chars[Math.floor(Math.random()*chars.length)];
  return n;
}

// ── MIDDLEWARE
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));

// ── AUTH HELPERS
const sign  = u => jwt.sign({ id: u.id, email: u.email, role: u.role }, JWT, { expiresIn: '7d' });
const auth  = (req, res, next) => {
  const t = req.headers.authorization?.replace('Bearer ', '');
  if (!t) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(t, JWT); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
};
const admin = (req, res, next) => auth(req, res, () => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
});
const orderNum = () => 'AF-' + Date.now().toString(36).toUpperCase().slice(-6);

// ══════════════════════════════════════════
//  PUBLIC ROUTES
// ══════════════════════════════════════════

app.get('/api/health', (_, res) => res.json({ status: 'ok' }));

// Settings
app.get('/api/settings', async (_, res) => {
  try {
    const { rows } = await pool.query('SELECT key,value FROM store_settings');
    const obj = {}; rows.forEach(r => obj[r.key] = r.value);
    res.json(obj);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Hero slides
app.get('/api/hero', async (_, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM hero_slides WHERE active=true ORDER BY sort_order');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Products list
app.get('/api/products', async (req, res) => {
  try {
    const { cat, badge, search, sort, limit = 100, offset = 0 } = req.query;
    const where = ['p.active=true']; const params = []; let i = 1;
    if (cat)    { where.push(`c.slug=$${i++}`); params.push(cat); }
    if (badge)  { where.push(`p.badge=$${i++}`); params.push(badge); }
    if (search) { where.push(`p.name ILIKE $${i++}`); params.push('%'+search+'%'); }
    const sorts = { price_asc:'p.price ASC', price_desc:'p.price DESC', rating:'p.rating DESC', name_asc:'p.name ASC', newest:'p.created_at DESC' };
    params.push(limit, offset);
    const { rows } = await pool.query(`
      SELECT p.*, c.name AS category_name, c.slug AS category_slug,
        COALESCE(json_agg(pi.url ORDER BY pi.sort_order) FILTER (WHERE pi.url IS NOT NULL),'[]') AS images
      FROM products p
      LEFT JOIN categories c ON c.id=p.category_id
      LEFT JOIN product_images pi ON pi.product_id=p.id
      WHERE ${where.join(' AND ')}
      GROUP BY p.id,c.name,c.slug
      ORDER BY ${sorts[sort]||'p.created_at DESC'}
      LIMIT $${i} OFFSET $${i+1}
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Single product
app.get('/api/products/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.*, c.name AS category_name, c.slug AS category_slug,
        COALESCE(json_agg(pi.url ORDER BY pi.sort_order) FILTER (WHERE pi.url IS NOT NULL),'[]') AS images
      FROM products p
      LEFT JOIN categories c ON c.id=p.category_id
      LEFT JOIN product_images pi ON pi.product_id=p.id
      WHERE (p.slug=$1 OR p.id::text=$1) AND p.active=true
      GROUP BY p.id,c.name,c.slug
    `, [req.params.slug]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, firstName, lastName, phone } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (email,password,first_name,last_name,phone) VALUES ($1,$2,$3,$4,$5) RETURNING id,email,first_name,last_name,role',
      [email.toLowerCase(), hash, firstName||'', lastName||'', phone||'']
    );
    res.json({ token: sign(rows[0]), user: rows[0] });
  } catch(e) {
    if (e.code==='23505') return res.status(400).json({ error: 'Email already registered' });
    res.status(500).json({ error: e.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email?.toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    if (!await bcrypt.compare(password, rows[0].password)) return res.status(401).json({ error: 'Invalid credentials' });
    const { password: _, ...user } = rows[0];
    res.json({ token: sign(user), user });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Me
app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id,email,first_name,last_name,phone,role FROM users WHERE id=$1', [req.user.id]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Setup admin
app.post('/api/setup', async (req, res) => {
  try {
    const { secret, password } = req.body;
    if (secret !== (process.env.SETUP_SECRET || 'africhic-setup-2025')) return res.status(403).json({ error: 'Invalid secret' });
    const hash = await bcrypt.hash(password || 'Africhic@Admin2025', 10);
    await pool.query('UPDATE users SET password=$1 WHERE email=$2', [hash, 'admin@africhic.co.za']);
    res.json({ success: true, message: 'Admin password set' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create order — seeds first tracking event automatically
app.post('/api/orders', async (req, res) => {
  const client = await pool.connect();
  try {
    const { items, shipping, deliveryMethod, deliveryFee, paymentMethod, promoCode, discount, guestEmail } = req.body;
    if (!items?.length) return res.status(400).json({ error: 'No items' });
    await client.query('BEGIN');
    const sub   = items.reduce((s,i) => s + i.price * i.qty, 0);
    const total = sub + (deliveryFee||0) - (discount||0);
    const num   = orderNum();
    const userId = req.headers.authorization ? (jwt.decode(req.headers.authorization.replace('Bearer ',''))?.id||null) : null;
    const { rows:[o] } = await client.query(`
      INSERT INTO orders (order_number,user_id,guest_email,status,subtotal,delivery_fee,total,delivery_method,payment_method,promo_code,discount,ship_first_name,ship_last_name,ship_street,ship_city,ship_province,ship_postal,ship_phone)
      VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id
    `, [num,userId,guestEmail,sub,deliveryFee||0,total,deliveryMethod,paymentMethod,promoCode,discount||0,shipping.firstName,shipping.lastName,shipping.street,shipping.city,shipping.province,shipping.postal||'',shipping.phone||'']);
    for (const item of items) {
      await client.query('INSERT INTO order_items (order_id,product_id,product_name,product_image,size,price,qty) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [o.id,item.productId,item.name,item.image,item.size,item.price,item.qty]);
      await client.query('UPDATE products SET stock=GREATEST(0,stock-$1) WHERE id=$2', [item.qty,item.productId]);
    }
    // Auto-seed first tracking event
    await client.query(
      'INSERT INTO order_tracking (order_id, status, message) VALUES ($1,$2,$3)',
      [o.id, 'pending', 'Your order has been received and is awaiting processing. Thank you for shopping with Africhic! ✦']
    );
    await client.query('COMMIT');
    
    // Send confirmation email (async, don't block response)
    const customerEmail = guestEmail || (userId ? (await pool.query('SELECT email FROM users WHERE id=$1',[userId])).rows[0]?.email : null);
    const custName = [shipping.firstName, shipping.lastName].filter(Boolean).join(' ') || 'Valued Customer';
    const itemRows = items.map(i=>`<tr><td style="padding:6px 0;font-size:.82rem;color:#3d2b1f">${i.name} (${i.size})</td><td style="padding:6px 0;font-size:.82rem;text-align:right;color:#8b5a32">×${i.qty} — R${(i.price*i.qty).toFixed(2)}</td></tr>`).join('');
    const confirmBody = `<p>Hi <strong>${custName}</strong>,</p>
<p>Thank you for your order! We've received it and it's now being processed.</p>
<div class="msg-box"><p>Your order <strong>${num}</strong> has been confirmed. You'll receive updates as it progresses.</p></div>
<table style="width:100%;border-collapse:collapse;margin:14px 0">${itemRows}
<tr style="border-top:2px solid #e8ddd0"><td style="padding:10px 0;font-weight:600;font-size:.88rem">Total</td><td style="padding:10px 0;font-weight:600;text-align:right;color:#8b5a32;font-size:.88rem">R${total.toFixed(2)}</td></tr></table>`;
    sendOrderEmail(customerEmail, `✦ Order Confirmed — ${num}`, emailTemplate('Order Confirmed ✦', confirmBody, num, null));
    
    // Admin alert
    sendAdminAlert(`New Order ${num} — R${total.toFixed(2)}`, 
      `<p>New order placed: <strong>${num}</strong></p><p>Customer: ${custName} (${customerEmail||'guest'})</p><p>Total: R${total.toFixed(2)}</p><p><a href="${SITE_URL}/admin.html">View in Admin →</a></p>`);
    
    res.json({ orderNumber: num, orderId: o.id });
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// My orders — with tracking (subquery avoids DISTINCT+ORDER BY PostgreSQL error)
app.get('/api/my/orders', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT o.*,
        (SELECT COALESCE(json_agg(x ORDER BY x_order), '[]') FROM (
          SELECT json_build_object(
            'id',oi.id,'name',oi.product_name,'image',oi.product_image,
            'size',oi.size,'price',oi.price,'qty',oi.qty
          ) AS x, oi.id AS x_order
          FROM order_items oi WHERE oi.order_id=o.id
        ) t) AS items,
        (SELECT COALESCE(json_agg(x ORDER BY x_ts), '[]') FROM (
          SELECT json_build_object(
            'id',ot.id,'status',ot.status,'message',ot.message,'created_at',ot.created_at
          ) AS x, ot.created_at AS x_ts
          FROM order_tracking ot WHERE ot.order_id=o.id
        ) t) AS tracking
      FROM orders o
      WHERE o.user_id=$1
      ORDER BY o.created_at DESC
    `, [req.user.id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Public order tracking — order_number + email, no login needed
app.get('/api/track', async (req, res) => {
  try {
    const { order_number, email } = req.query;
    if (!order_number || !email) return res.status(400).json({ error: 'Order number and email required' });
    const { rows } = await pool.query(`
      SELECT o.order_number, o.status, o.created_at, o.total, o.delivery_method,
             o.tracking_number, o.courier, o.estimated_delivery,
             o.ship_first_name, o.ship_last_name, o.ship_city, o.ship_province,
        (SELECT COALESCE(json_agg(x ORDER BY x_id), '[]') FROM (
          SELECT json_build_object(
            'id',oi.id,'name',oi.product_name,'image',oi.product_image,
            'size',oi.size,'price',oi.price,'qty',oi.qty
          ) AS x, oi.id AS x_id
          FROM order_items oi WHERE oi.order_id=o.id
        ) t) AS items,
        (SELECT COALESCE(json_agg(x ORDER BY x_ts), '[]') FROM (
          SELECT json_build_object(
            'id',ot.id,'status',ot.status,'message',ot.message,'created_at',ot.created_at
          ) AS x, ot.created_at AS x_ts
          FROM order_tracking ot WHERE ot.order_id=o.id AND ot.is_public=true
        ) t) AS tracking
      FROM orders o
      WHERE UPPER(o.order_number)=UPPER($1)
        AND (
          LOWER(COALESCE(o.guest_email,''))=LOWER($2)
          OR o.user_id IN (SELECT id FROM users WHERE LOWER(email)=LOWER($2))
        )
    `, [order_number.trim(), email.trim()]);
    if (!rows.length) return res.status(404).json({ error: 'Order not found. Please check your order number and email.' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Promo validate
app.post('/api/promo/validate', async (req, res) => {
  try {
    const { code, total } = req.body;
    const { rows:[p] } = await pool.query('SELECT * FROM promo_codes WHERE code=UPPER($1) AND active=true', [code]);
    if (!p) return res.status(400).json({ error: 'Invalid promo code' });
    if (p.expires_at && new Date(p.expires_at) < new Date()) return res.status(400).json({ error: 'Code expired' });
    if (p.max_uses && p.uses >= p.max_uses) return res.status(400).json({ error: 'Code limit reached' });
    if (total < p.min_order) return res.status(400).json({ error: `Min order R${p.min_order} required` });
    const discount = p.type==='percent' ? total*p.value/100 : Math.min(p.value,total);
    res.json({ valid:true, discount:+discount.toFixed(2), type:p.type, value:p.value });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Newsletter
app.post('/api/newsletter', async (req, res) => {
  try {
    const { email } = req.body;
    await pool.query('INSERT INTO subscribers (email) VALUES ($1) ON CONFLICT DO NOTHING', [email?.toLowerCase()]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════════════════

// Stats
app.get('/api/admin/stats', admin, async (_, res) => {
  try {
    const [o,r,c,p,pend,low] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM orders'),
      pool.query("SELECT COALESCE(SUM(total),0) FROM orders WHERE status!='cancelled'"),
      pool.query("SELECT COUNT(*) FROM users WHERE role='customer'"),
      pool.query('SELECT COUNT(*) FROM products WHERE active=true'),
      pool.query("SELECT COUNT(*) FROM orders WHERE status='pending'"),
      pool.query('SELECT COUNT(*) FROM products WHERE stock<=5 AND active=true')
    ]);
    res.json({ totalOrders:+o.rows[0].count, revenue:+r.rows[0].coalesce, customers:+c.rows[0].count, products:+p.rows[0].count, pendingOrders:+pend.rows[0].count, lowStockCount:+low.rows[0].count });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin orders list
app.get('/api/admin/orders', admin, async (req, res) => {
  try {
    const { status, limit=50 } = req.query;
    const where = status ? 'WHERE o.status=$1' : '';
    const params = status ? [status,limit] : [limit];
    const li = status ? 2 : 1;
    const { rows } = await pool.query(`
      SELECT o.*, COALESCE(u.first_name||' '||u.last_name, o.guest_email,'Guest') AS customer_name,
        json_agg(json_build_object('name',oi.product_name,'qty',oi.qty,'price',oi.price,'image',oi.product_image,'size',oi.size)) AS items
      FROM orders o LEFT JOIN users u ON u.id=o.user_id LEFT JOIN order_items oi ON oi.order_id=o.id
      ${where} GROUP BY o.id,u.first_name,u.last_name ORDER BY o.created_at DESC LIMIT $${li}
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin: full order detail — items + tracking timeline
app.get('/api/admin/orders/:id', admin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT o.*, u.email AS customer_email, u.first_name, u.last_name, u.phone,
        (SELECT COALESCE(json_agg(x ORDER BY x_id), '[]') FROM (
          SELECT json_build_object(
            'id',oi.id,'name',oi.product_name,'image',oi.product_image,
            'size',oi.size,'price',oi.price,'qty',oi.qty
          ) AS x, oi.id AS x_id
          FROM order_items oi WHERE oi.order_id=o.id
        ) t) AS items,
        (SELECT COALESCE(json_agg(x ORDER BY x_ts), '[]') FROM (
          SELECT json_build_object(
            'id',ot.id,'status',ot.status,'message',ot.message,'created_at',ot.created_at
          ) AS x, ot.created_at AS x_ts
          FROM order_tracking ot WHERE ot.order_id=o.id
        ) t) AS tracking
      FROM orders o
      LEFT JOIN users u ON u.id=o.user_id
      WHERE o.id=$1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin: update order status + log tracking event atomically
app.patch('/api/admin/orders/:id/status', admin, async (req, res) => {
  try {
    const valid = ['pending','processing','shipped','delivered','cancelled'];
    const { status, message, trackingNumber, courier, estimatedDelivery } = req.body;
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Build SET clause dynamically — only include provided optional fields
      const setClauses = ['status=$1', 'updated_at=NOW()'];
      const params = [status, req.params.id];
      if (trackingNumber) { params.push(trackingNumber); setClauses.push(`tracking_number=$${params.length}`); }
      if (courier)        { params.push(courier);        setClauses.push(`courier=$${params.length}`); }
      if (estimatedDelivery) { params.push(estimatedDelivery); setClauses.push(`estimated_delivery=$${params.length}`); }
      await client.query(`UPDATE orders SET ${setClauses.join(',')} WHERE id=$2`, params);
      // Auto-generate tracking number when shipping
      let finalTrackingNum = trackingNumber;
      if (status === 'shipped' && !finalTrackingNum) {
        finalTrackingNum = genTrackingNum();
        if (!setClauses.find(c=>c.includes('tracking_number'))) {
          params.push(finalTrackingNum);
          setClauses.push(`tracking_number=$${params.length}`);
        }
      }
      const defaultMsg = {
        pending:    'Your order has been received and is awaiting processing.',
        processing: 'Great news — your order is being carefully prepared and packed.',
        shipped:    'Your order has been shipped! Tracking: ' + (finalTrackingNum||'') + (courier ? ' via ' + courier : '') + '. Estimated delivery in 2–5 business days.',
        delivered:  'Your order has been delivered. Thank you for shopping with Africhic! ✦',
        cancelled:  'Your order has been cancelled. Please contact us if you have any questions.'
      };
      const finalMsg = message || defaultMsg[status];
      await client.query(
        'INSERT INTO order_tracking (order_id, status, message, created_by) VALUES ($1,$2,$3,$4)',
        [req.params.id, status, finalMsg, req.user.id]
      );
      await client.query('COMMIT');
      
      // Send email notification to customer
      const orderRow = await pool.query(
        'SELECT o.*, u.email AS uemail, o.guest_email FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE o.id=$1',
        [req.params.id]
      );
      if (orderRow.rows.length) {
        const or = orderRow.rows[0];
        const toEmail = or.uemail || or.guest_email;
        const custName = [or.ship_first_name, or.ship_last_name].filter(Boolean).join(' ') || 'Valued Customer';
        const subj = (STATUS_SUBJECT[status]||'Order Update — {num}').replace('{num}', or.order_number);
        const statusColors = {pending:'#856404',processing:'#004085',shipped:'#155724',delivered:'#155724',cancelled:'#721c24'};
        const statusBg = {pending:'#fff3cd',processing:'#cce5ff',shipped:'#d4edda',delivered:'#d4edda',cancelled:'#f8d7da'};
        const emailBody = `<p>Hi <strong>${custName}</strong>,</p>
<p>There's an update on your order <strong>${or.order_number}</strong>.</p>
<div style="margin:12px 0"><span class="status-chip" style="background:${statusBg[status]||'#f5f0e8'};color:${statusColors[status]||'#3d2b1f'}">${status}</span></div>
<div class="msg-box"><p>${finalMsg}</p></div>
${estimatedDelivery?`<p style="font-size:.82rem;color:#5a4238">📅 Estimated delivery: <strong>${new Date(estimatedDelivery).toLocaleDateString('en-ZA',{dateStyle:'long'})}</strong></p>`:''}`;
        sendOrderEmail(toEmail, subj, emailTemplate(subj, emailBody, or.order_number, finalTrackingNum));
        // Admin notification for new orders
        if (status === 'delivered') {
          sendAdminAlert(`Order Delivered: ${or.order_number}`, `<p>Order ${or.order_number} marked as delivered for ${custName}.</p>`);
        }
      }
      res.json({ success: true, trackingNumber: finalTrackingNum });
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin: add a message without changing status
app.post('/api/admin/orders/:id/message', admin, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message required' });
    const { rows } = await pool.query('SELECT status FROM orders WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    await pool.query(
      'INSERT INTO order_tracking (order_id, status, message, created_by) VALUES ($1,$2,$3,$4)',
      [req.params.id, rows[0].status, message.trim(), req.user.id]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin products
app.get('/api/admin/products', admin, async (_, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.*, c.name AS category_name,
        COALESCE(json_agg(pi.url ORDER BY pi.sort_order) FILTER (WHERE pi.url IS NOT NULL),'[]') AS images
      FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN product_images pi ON pi.product_id=p.id
      GROUP BY p.id,c.name ORDER BY p.created_at DESC
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/products', admin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, categoryId, description, price, originalPrice, badge, sizes, stock, images } = req.body;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')+'-'+Date.now().toString(36);
    await client.query('BEGIN');
    const { rows:[p] } = await client.query(
      'INSERT INTO products (name,slug,category_id,description,price,original_price,badge,sizes,stock) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [name,slug,categoryId,description,price,originalPrice||null,badge||'',sizes||[],stock||0]
    );
    if (Array.isArray(images) && images.length)
      for (let i=0;i<images.length;i++) await client.query('INSERT INTO product_images (product_id,url,sort_order) VALUES ($1,$2,$3)',[p.id,images[i],i]);
    await client.query('COMMIT'); res.json(p);
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

app.put('/api/admin/products/:id', admin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, categoryId, description, price, originalPrice, badge, sizes, stock, active, images } = req.body;
    await client.query('BEGIN');
    await client.query('UPDATE products SET name=$1,category_id=$2,description=$3,price=$4,original_price=$5,badge=$6,sizes=$7,stock=$8,active=$9,updated_at=NOW() WHERE id=$10',
      [name,categoryId,description,price,originalPrice||null,badge||'',sizes||[],stock,active!==false,req.params.id]);
    if (Array.isArray(images) && images.length) {
      await client.query('DELETE FROM product_images WHERE product_id=$1',[req.params.id]);
      for (let i=0;i<images.length;i++) await client.query('INSERT INTO product_images (product_id,url,sort_order) VALUES ($1,$2,$3)',[req.params.id,images[i],i]);
    }
    await client.query('COMMIT'); res.json({ success:true });
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

app.delete('/api/admin/products/:id', admin, async (req, res) => {
  try { await pool.query('UPDATE products SET active=false WHERE id=$1',[req.params.id]); res.json({ success:true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin hero slides
app.get('/api/admin/hero', admin, async (_, res) => {
  try { const { rows } = await pool.query('SELECT * FROM hero_slides ORDER BY sort_order'); res.json(rows); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/hero', admin, async (req, res) => {
  try {
    const { image,eyebrow,title,titleEm,subtitle,btnPrimaryText,btnPrimaryHref,btnSecondaryText,btnSecondaryHref,sortOrder } = req.body;
    const { rows:[s] } = await pool.query(
      'INSERT INTO hero_slides (image,eyebrow,title,title_em,subtitle,btn_primary_text,btn_primary_href,btn_secondary_text,btn_secondary_href,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [image,eyebrow,title,titleEm,subtitle,btnPrimaryText,btnPrimaryHref,btnSecondaryText,btnSecondaryHref,sortOrder||1]
    );
    res.json(s);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/hero/:id', admin, async (req, res) => {
  try {
    const { image,eyebrow,title,titleEm,subtitle,btnPrimaryText,btnPrimaryHref,btnSecondaryText,btnSecondaryHref,sortOrder,active } = req.body;
    await pool.query('UPDATE hero_slides SET image=$1,eyebrow=$2,title=$3,title_em=$4,subtitle=$5,btn_primary_text=$6,btn_primary_href=$7,btn_secondary_text=$8,btn_secondary_href=$9,sort_order=$10,active=$11 WHERE id=$12',
      [image,eyebrow,title,titleEm,subtitle,btnPrimaryText,btnPrimaryHref,btnSecondaryText,btnSecondaryHref,sortOrder,active!==false,req.params.id]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/hero/:id', admin, async (req, res) => {
  try { await pool.query('DELETE FROM hero_slides WHERE id=$1',[req.params.id]); res.json({ success:true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin settings
app.get('/api/admin/settings', admin, async (_, res) => {
  try {
    const { rows } = await pool.query('SELECT key,value FROM store_settings ORDER BY key');
    const obj = {}; rows.forEach(r => obj[r.key]=r.value); res.json(obj);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/settings', admin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [k,v] of Object.entries(req.body))
      await client.query('INSERT INTO store_settings (key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2,updated_at=NOW()',[k,String(v)]);
    await client.query('COMMIT'); res.json({ success:true });
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// Admin customers
app.get('/api/admin/customers', admin, async (_, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id,u.email,u.first_name,u.last_name,u.phone,u.created_at,COUNT(o.id) AS order_count,COALESCE(SUM(o.total),0) AS total_spent
      FROM users u LEFT JOIN orders o ON o.user_id=u.id WHERE u.role='customer' GROUP BY u.id ORDER BY u.created_at DESC
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin promos
app.get('/api/admin/promos', admin, async (_, res) => {
  try { const { rows } = await pool.query('SELECT * FROM promo_codes ORDER BY created_at DESC'); res.json(rows); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/promos', admin, async (req, res) => {
  try {
    const { code,type,value,minOrder,maxUses,expiresAt } = req.body;
    const { rows:[p] } = await pool.query('INSERT INTO promo_codes (code,type,value,min_order,max_uses,expires_at) VALUES (UPPER($1),$2,$3,$4,$5,$6) RETURNING *',
      [code,type,value,minOrder||0,maxUses||null,expiresAt||null]);
    res.json(p);
  } catch(e) {
    if (e.code==='23505') return res.status(400).json({ error:'Code already exists' });
    res.status(500).json({ error: e.message });
  }
});
app.patch('/api/admin/promos/:id', admin, async (req, res) => {
  try { await pool.query('UPDATE promo_codes SET active=$1 WHERE id=$2',[req.body.active,req.params.id]); res.json({ success:true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin image upload
app.post('/api/admin/upload', admin, async (req, res) => {
  try {
    const { base64 } = req.body;
    if (!base64) return res.status(400).json({ error: 'No image data' });
    res.json({ url: base64 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`🚀 Africhic API on port ${PORT}`));
