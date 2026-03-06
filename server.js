require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { Pool }= require('pg');

const app  = express();
const PORT = process.env.PORT || 3001;
const JWT  = process.env.JWT_SECRET || 'africhic_secret_2025';

// ── DATABASE
const _db = process.env.DATABASE_URL || '';
const DB_URL = _db.includes('uselibpqcompat') ? _db
  : _db + (_db.includes('?') ? '&' : '?') + 'uselibpqcompat=true&sslmode=require';
const pool = new Pool({ connectionString: DB_URL, max:10, idleTimeoutMillis:30000, connectionTimeoutMillis:5000 });
pool.query('SELECT 1').then(()=>console.log('✅ DB connected')).catch(e=>console.error('DB error:',e.message));
setInterval(()=>pool.query('SELECT 1').catch(()=>{}), 4*60*1000);

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

// Single product by slug or id
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

// Setup admin password (run once after deploy)
app.post('/api/setup', async (req, res) => {
  try {
    const { secret, password } = req.body;
    if (secret !== (process.env.SETUP_SECRET || 'africhic-setup-2025')) return res.status(403).json({ error: 'Invalid secret' });
    const hash = await bcrypt.hash(password || 'Africhic@Admin2025', 10);
    await pool.query('UPDATE users SET password=$1 WHERE email=$2', [hash, 'admin@africhic.co.za']);
    res.json({ success: true, message: 'Admin password set — you can now login' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create order
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
    await client.query('COMMIT');
    res.json({ orderNumber: num, orderId: o.id });
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// My orders (with tracking timeline)
app.get('/api/my/orders', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT o.*,
        (SELECT COALESCE(json_agg(x ORDER BY x_order), '[]') FROM (
          SELECT json_build_object('id',oi.id,'name',oi.product_name,'image',oi.product_image,
            'size',oi.size,'price',oi.price,'qty',oi.qty) AS x, oi.id AS x_order
          FROM order_items oi WHERE oi.order_id=o.id
        ) t) AS items,
        (SELECT COALESCE(json_agg(x ORDER BY x_order), '[]') FROM (
          SELECT json_build_object('id',ot.id,'status',ot.status,'message',ot.message,
            'created_at',ot.created_at) AS x, ot.created_at AS x_order
          FROM order_tracking ot WHERE ot.order_id=o.id
        ) t) AS tracking
      FROM orders o
      WHERE o.user_id=$1
      ORDER BY o.created_at DESC
    `, [req.user.id]);
    res.json(rows);
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

// Admin orders
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

app.patch('/api/admin/orders/:id/status', admin, async (req, res) => {
  try {
    const valid = ['pending','processing','shipped','delivered','cancelled'];
    const { status, message, trackingNumber, courier, estimatedDelivery } = req.body;
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Build UPDATE dynamically but safely
      const setClauses = ['status=$1', 'updated_at=NOW()'];
      const params = [status, req.params.id];
      if (trackingNumber) { params.push(trackingNumber); setClauses.push(`tracking_number=$${params.length}`); }
      if (courier)        { params.push(courier);        setClauses.push(`courier=$${params.length}`); }
      if (estimatedDelivery) { params.push(estimatedDelivery); setClauses.push(`estimated_delivery=$${params.length}`); }
      await client.query(
        `UPDATE orders SET ${setClauses.join(',')} WHERE id=$2`,
        params
      );
      const defaultMsg = {
        pending:    'Your order has been received and is awaiting processing.',
        processing: 'Your order is being carefully prepared and packed.',
        shipped:    trackingNumber
          ? 'Your order has been shipped. Tracking: '+trackingNumber+(courier?' via '+courier:'')
          : 'Your order has been shipped and is on its way!',
        delivered:  'Your order has been delivered. Thank you for shopping with Africhic! ✦',
        cancelled:  'Your order has been cancelled. Please contact us if you have questions.'
      };
      await client.query(
        'INSERT INTO order_tracking (order_id, status, message, created_by) VALUES ($1,$2,$3,$4)',
        [req.params.id, status, message || defaultMsg[status], req.user.id]
      );
      await client.query('COMMIT');
      res.json({ success: true });
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin: send a message on an order without changing status
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

// Admin: full order detail with items + tracking timeline
app.get('/api/admin/orders/:id', admin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT o.*, u.email AS customer_email, u.first_name, u.last_name, u.phone,
        (SELECT COALESCE(json_agg(x ORDER BY x_id), '[]') FROM (
          SELECT json_build_object('id',oi.id,'name',oi.product_name,'image',oi.product_image,
            'size',oi.size,'price',oi.price,'qty',oi.qty) AS x, oi.id AS x_id
          FROM order_items oi WHERE oi.order_id=o.id
        ) t) AS items,
        (SELECT COALESCE(json_agg(x ORDER BY x_ts), '[]') FROM (
          SELECT json_build_object('id',ot.id,'status',ot.status,'message',ot.message,
            'created_at',ot.created_at) AS x, ot.created_at AS x_ts
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

// Public order tracking — no auth, requires order_number + email
app.get('/api/track', async (req, res) => {
  try {
    const { order_number, email } = req.query;
    if (!order_number || !email) return res.status(400).json({ error: 'Order number and email required' });
    const { rows } = await pool.query(`
      SELECT o.order_number, o.status, o.created_at, o.total, o.delivery_method,
             o.tracking_number, o.courier, o.estimated_delivery,
             o.ship_first_name, o.ship_last_name, o.ship_city, o.ship_province,
        (SELECT COALESCE(json_agg(x ORDER BY x_id), '[]') FROM (
          SELECT json_build_object('id',oi.id,'name',oi.product_name,'image',oi.product_image,
            'size',oi.size,'price',oi.price,'qty',oi.qty) AS x, oi.id AS x_id
          FROM order_items oi WHERE oi.order_id=o.id
        ) t) AS items,
        (SELECT COALESCE(json_agg(x ORDER BY x_ts), '[]') FROM (
          SELECT json_build_object('id',ot.id,'status',ot.status,'message',ot.message,
            'created_at',ot.created_at) AS x, ot.created_at AS x_ts
          FROM order_tracking ot WHERE ot.order_id=o.id AND ot.is_public=true
        ) t) AS tracking
      FROM orders o
      WHERE UPPER(o.order_number)=UPPER($1)
        AND (LOWER(o.guest_email)=LOWER($2)
          OR o.user_id IN (SELECT id FROM users WHERE LOWER(email)=LOWER($2)))
    `, [order_number.trim(), email.trim()]);
    if (!rows.length) return res.status(404).json({ error: 'Order not found. Please check your order number and email.' });
    res.json(rows[0]);
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
    if (images?.length) for (let i=0;i<images.length;i++) await client.query('INSERT INTO product_images (product_id,url,sort_order) VALUES ($1,$2,$3)',[p.id,images[i],i]);
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
    if (Array.isArray(images) && images.length > 0) {
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

// Admin image upload (base64 → stores URL in DB, file hosted on Netlify)
app.post('/api/admin/upload', admin, async (req, res) => {
  try {
    // On Railway filesystem is ephemeral — return the base64 as data URL
    // For production, integrate Cloudinary or similar
    const { base64, filename } = req.body;
    if (!base64) return res.status(400).json({ error: 'No image data' });
    // Return the base64 as a usable image URL
    res.json({ url: base64, note: 'Stored as base64. For permanent storage integrate Cloudinary.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`🚀 Africhic API on port ${PORT}`));
