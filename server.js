require('dotenv').config();
// v3.0 — PostgreSQL + full chat + DB reset
const express    = require('express');
const http       = require('http');
const socketIo   = require('socket.io');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const multer     = require('multer');
const path       = require('path');
const { Pool }   = require('pg');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'unitalk-secret-change-in-prod';
const PORT       = process.env.PORT || 3000;

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false,
});

// Helpers: convert ? → $1,$2,... and run queries
function toPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}
async function dbGet(sql, p = [])  { const r = await pool.query(toPlaceholders(sql), p); return r.rows[0]; }
async function dbAll(sql, p = [])  { const r = await pool.query(toPlaceholders(sql), p); return r.rows; }
async function dbRun(sql, p = [])  {
  const pg = toPlaceholders(sql);
  // INSERT … RETURNING id  gives us lastInsertRowid
  const suffix = /^\s*INSERT/i.test(sql) ? ' RETURNING id' : '';
  const r = await pool.query(pg + suffix, p);
  return { lastInsertRowid: r.rows[0]?.id };
}

// ── Schema ────────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      email       TEXT UNIQUE NOT NULL,
      password    TEXT NOT NULL,
      role        TEXT NOT NULL CHECK(role IN ('applicant','student','reporter','admin')),
      full_name   TEXT NOT NULL,
      avatar      TEXT DEFAULT '/avatars/default.png',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS universities (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      city        TEXT,
      description TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS faculties (
      id            SERIAL PRIMARY KEY,
      university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      description   TEXT
    );
    CREATE TABLE IF NOT EXISTS student_profiles (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      university_id   INTEGER REFERENCES universities(id) ON DELETE SET NULL,
      faculty_id      INTEGER REFERENCES faculties(id) ON DELETE SET NULL,
      course          INTEGER CHECK(course BETWEEN 1 AND 6),
      graduation_year INTEGER,
      bio             TEXT,
      is_available    INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
      faculty_id    INTEGER REFERENCES faculties(id) ON DELETE SET NULL,
      rating        INTEGER CHECK(rating BETWEEN 1 AND 5),
      content       TEXT NOT NULL,
      is_anonymous  INTEGER DEFAULT 0,
      moderation_status TEXT DEFAULT 'pending' CHECK(moderation_status IN ('pending','approved')),
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
    -- Migration: add moderation_status if missing
    DO $$ BEGIN
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS moderation_status TEXT DEFAULT 'pending'
        CHECK(moderation_status IN ('pending','approved'));
    EXCEPTION WHEN others THEN NULL; END $$;
    CREATE TABLE IF NOT EXISTS chats (
      id           SERIAL PRIMARY KEY,
      user_a_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_a_id, user_b_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      sender_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content    TEXT NOT NULL,
      is_read    INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS news (
      id          SERIAL PRIMARY KEY,
      author_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL,
      image_url   TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_news_author ON news(author_id);
    CREATE INDEX IF NOT EXISTS idx_msg_chat   ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_rev_uni    ON reviews(university_id);
    CREATE INDEX IF NOT EXISTS idx_chat_a     ON chats(user_a_id);
    CREATE INDEX IF NOT EXISTS idx_chat_b     ON chats(user_b_id);
  `);
  console.log('✅ БД готова');
}

// ── Express setup ─────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// Automatic layout wrapper
app.use((req, res, next) => {
  const orig = res.render.bind(res);
  res.render = (view, opts = {}, cb) => {
    orig(view, opts, (err, body) => {
      if (err) return next(err);
      orig('layout', { ...opts, body }, cb || ((err2, html) => {
        if (err2) return next(err2);
        res.send(html);
      }));
    });
  };
  next();
});

const storage = multer.diskStorage({
  destination: './public/avatars/',
  filename:    (req, file, cb) => cb(null, `avatar-${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// ── Auth ──────────────────────────────────────────────────────────────────────
const auth = (roles = []) => (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.redirect('/login');
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    if (roles.length && !roles.includes(decoded.role)) return res.status(403).send('Доступ запрещён');
    next();
  } catch {
    res.clearCookie('token');
    res.redirect('/login');
  }
};

// Inject current user into every response
app.use(async (req, res, next) => {
  const token = req.cookies.token;
  if (token) {
    try {
      res.locals.user = await dbGet('SELECT * FROM users WHERE id=?', [jwt.verify(token, JWT_SECRET).id]);
    } catch { res.locals.user = null; }
  } else { res.locals.user = null; }
  next();
});

// ── Helper: find or create a chat between two users ──────────────────────────
async function findOrCreateChat(aId, bId) {
  // Store always with smaller id as user_a for uniqueness
  const [lo, hi] = aId < bId ? [aId, bId] : [bId, aId];
  let chat = await pool.query(
    'SELECT id FROM chats WHERE user_a_id=$1 AND user_b_id=$2', [lo, hi]
  ).then(r => r.rows[0]);
  if (!chat) {
    const ins = await pool.query(
      'INSERT INTO chats (user_a_id, user_b_id) VALUES ($1,$2) RETURNING id', [lo, hi]
    );
    chat = ins.rows[0];
  }
  return chat;
}

// ── Public pages ──────────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  const universities  = await dbAll('SELECT * FROM universities ORDER BY name');
  const recentReviews = await dbAll(`
    SELECT r.*, u.full_name, un.name as university_name, f.name as faculty_name
    FROM reviews r JOIN users u ON r.user_id=u.id
    JOIN universities un ON r.university_id=un.id
    LEFT JOIN faculties f ON r.faculty_id=f.id
    ORDER BY r.created_at DESC LIMIT 10`);
  res.render('index', { universities, recentReviews });
});

app.get('/register', (req, res) => res.render('register', { error: null }));
app.post('/register', async (req, res) => {
  const { email, password, full_name, role } = req.body;
  if (await dbGet('SELECT id FROM users WHERE email=?', [email]))
    return res.render('register', { error: 'Email уже зарегистрирован' });
  const hash = await bcrypt.hash(password, 10);
  // Only allow reporter/admin roles via admin panel — public registration limited to applicant/student
  const safeRole = ['applicant','student'].includes(role) ? role : 'applicant';
  const { lastInsertRowid: id } = await dbRun(
    'INSERT INTO users (email,password,full_name,role) VALUES (?,?,?,?)',
    [email, hash, full_name, safeRole]
  );
  const token = jwt.sign({ id, email, role: safeRole }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, { httpOnly: true, maxAge: 7*24*60*60*1000 });
  res.redirect('/');
});

app.get('/login',  (req, res) => res.render('login', { error: null }));
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await dbGet('SELECT * FROM users WHERE email=?', [email]);
  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.render('login', { error: 'Неверный email или пароль' });
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, { httpOnly: true, maxAge: 7*24*60*60*1000 });
  res.redirect('/');
});
app.get('/logout', (req, res) => { res.clearCookie('token'); res.redirect('/'); });

// ── Profile ───────────────────────────────────────────────────────────────────
app.get('/profile', auth(), async (req, res) => {
  const user         = await dbGet('SELECT * FROM users WHERE id=?', [req.user.id]);
  const universities = await dbAll('SELECT * FROM universities ORDER BY name');
  let studentProfile = null;
  if (user.role === 'student') {
    studentProfile = await dbGet(`
      SELECT sp.*, u.name as university_name, f.name as faculty_name
      FROM student_profiles sp
      LEFT JOIN universities u ON sp.university_id=u.id
      LEFT JOIN faculties f ON sp.faculty_id=f.id
      WHERE sp.user_id=?`, [user.id]);
  }
  res.render('profile', { user, studentProfile, universities, error: null });
});

app.post('/profile', auth(), upload.single('avatar'), async (req, res) => {
  if (req.file)
    await pool.query('UPDATE users SET avatar=$1 WHERE id=$2', [`/avatars/${req.file.filename}`, req.user.id]);
  if (req.user.role === 'student') {
    const { university_id, faculty_id, course, graduation_year, bio } = req.body;
    const exists = await dbGet('SELECT id FROM student_profiles WHERE user_id=?', [req.user.id]);
    if (exists) {
      await pool.query(
        'UPDATE student_profiles SET university_id=$1,faculty_id=$2,course=$3,graduation_year=$4,bio=$5 WHERE user_id=$6',
        [university_id||null, faculty_id||null, course||null, graduation_year||null, bio||null, req.user.id]);
    } else {
      await pool.query(
        'INSERT INTO student_profiles (user_id,university_id,faculty_id,course,graduation_year,bio) VALUES ($1,$2,$3,$4,$5,$6)',
        [req.user.id, university_id||null, faculty_id||null, course||null, graduation_year||null, bio||null]);
    }
  }
  res.redirect('/profile');
});

// Public user profile
app.get('/user/:id', auth(), async (req, res) => {
  const profileUser = await dbGet('SELECT * FROM users WHERE id=?', [req.params.id]);
  if (!profileUser) return res.status(404).send('Пользователь не найден');
  let studentProfile = null;
  if (profileUser.role === 'student') {
    studentProfile = await dbGet(`
      SELECT sp.*, u.name as university_name, f.name as faculty_name
      FROM student_profiles sp
      LEFT JOIN universities u ON sp.university_id=u.id
      LEFT JOIN faculties f ON sp.faculty_id=f.id
      WHERE sp.user_id=?`, [profileUser.id]);
  }
  res.render('user-profile', { profileUser, studentProfile });
});

app.get('/api/faculties/:universityId', async (req, res) => {
  res.json(await dbAll('SELECT * FROM faculties WHERE university_id=? ORDER BY name', [req.params.universityId]));
});

// ── Universities ──────────────────────────────────────────────────────────────
app.get('/universities', async (req, res) => {
  const universities = await dbAll(`
    SELECT u.*, COUNT(DISTINCT r.id) as review_count, ROUND(AVG(r.rating)::numeric,1) as avg_rating
    FROM universities u LEFT JOIN reviews r ON u.id=r.university_id
    GROUP BY u.id ORDER BY u.name`);
  res.render('universities', { universities });
});

app.get('/universities/:id', async (req, res) => {
  const university = await dbGet('SELECT * FROM universities WHERE id=?', [req.params.id]);
  if (!university) return res.status(404).send('Вуз не найден');
  const faculties = await dbAll('SELECT * FROM faculties WHERE university_id=? ORDER BY name', [req.params.id]);
  const reviews   = await dbAll(`
    SELECT r.*, CASE WHEN r.is_anonymous=1 THEN 'Аноним' ELSE u.full_name END as display_name,
           u.avatar, f.name as faculty_name
    FROM reviews r JOIN users u ON r.user_id=u.id
    LEFT JOIN faculties f ON r.faculty_id=f.id
    WHERE r.university_id=? ORDER BY r.created_at DESC`, [req.params.id]);
  res.render('university', { university, faculties, reviews, error: null });
});

app.post('/universities/:id/review', auth(), async (req, res) => {
  const { faculty_id, rating, content, is_anonymous } = req.body;
  await pool.query(
    'INSERT INTO reviews (user_id,university_id,faculty_id,rating,content,is_anonymous) VALUES ($1,$2,$3,$4,$5,$6)',
    [req.user.id, req.params.id, faculty_id||null, rating, content, is_anonymous ? 1 : 0]);
  res.redirect(`/universities/${req.params.id}`);
});

// ── Chats ─────────────────────────────────────────────────────────────────────
app.get('/chats', auth(), async (req, res) => {
  const uid = req.user.id;
  const chats = await pool.query(`
    SELECT c.*,
      CASE WHEN c.user_a_id=$1 THEN ub.full_name ELSE ua.full_name END  AS full_name,
      CASE WHEN c.user_a_id=$1 THEN ub.avatar    ELSE ua.avatar    END  AS avatar,
      CASE WHEN c.user_a_id=$1 THEN c.user_b_id  ELSE c.user_a_id  END  AS partner_id,
      (SELECT content    FROM messages WHERE chat_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM messages WHERE chat_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_at,
      (SELECT COUNT(*)   FROM messages WHERE chat_id=c.id AND sender_id!=$1 AND is_read=0)  AS unread_count
    FROM chats c
    JOIN users ua ON c.user_a_id=ua.id
    JOIN users ub ON c.user_b_id=ub.id
    WHERE c.user_a_id=$1 OR c.user_b_id=$1
    ORDER BY last_at DESC NULLS LAST
  `, [uid]).then(r => r.rows);

  // All users except self to start new chats
  const allUsers = await pool.query(`
    SELECT u.id, u.full_name, u.avatar, u.role, sp.bio,
           un.name AS university_name, f.name AS faculty_name, sp.course
    FROM users u
    LEFT JOIN student_profiles sp ON u.id=sp.user_id
    LEFT JOIN universities un ON sp.university_id=un.id
    LEFT JOIN faculties f ON sp.faculty_id=f.id
    WHERE u.id!=$1 ORDER BY u.full_name
  `, [uid]).then(r => r.rows);

  res.render('chats', { chats, allUsers, user: res.locals.user });
});

// Start or open chat with any user
app.post('/chats/start/:targetId', auth(), async (req, res) => {
  const chat = await findOrCreateChat(req.user.id, parseInt(req.params.targetId));
  res.redirect(`/chats/${chat.id}`);
});

// Also support GET link from user profiles  
app.get('/chats/start/:targetId', auth(), async (req, res) => {
  const chat = await findOrCreateChat(req.user.id, parseInt(req.params.targetId));
  res.redirect(`/chats/${chat.id}`);
});

app.get('/chats/:id', auth(), async (req, res) => {
  const chat = await dbGet('SELECT * FROM chats WHERE id=?', [req.params.id]);
  if (!chat) return res.status(404).send('Чат не найден');
  const uid = req.user.id;
  if (chat.user_a_id !== uid && chat.user_b_id !== uid && req.user.role !== 'admin')
    return res.status(403).send('Доступ запрещён');
  const partnerId = uid === chat.user_a_id ? chat.user_b_id : chat.user_a_id;
  const partner   = await dbGet('SELECT * FROM users WHERE id=?', [partnerId]);
  const messages  = await dbAll(`
    SELECT m.*, u.full_name, u.avatar FROM messages m JOIN users u ON m.sender_id=u.id
    WHERE m.chat_id=? ORDER BY m.created_at ASC LIMIT 200`, [req.params.id]);
  await pool.query('UPDATE messages SET is_read=1 WHERE chat_id=$1 AND sender_id!=$2 AND is_read=0',
    [req.params.id, uid]);
  res.render('chat', { chat, partner, messages });
});


// ── News ──────────────────────────────────────────────────────────────────────
app.get('/news', async (req, res) => {
  const newsList = await dbAll(`
    SELECT n.*, u.full_name AS author_name, u.avatar AS author_avatar, u.role AS author_role
    FROM news n JOIN users u ON n.author_id=u.id
    ORDER BY n.created_at DESC`);
  res.render('news', { newsList });
});

app.get('/news/create', auth(['reporter','admin']), (req, res) => {
  res.render('news-create', { error: null });
});

app.post('/news/create', auth(['reporter','admin']), upload.single('image'), async (req, res) => {
  const { title, content } = req.body;
  const image_url = req.file ? `/avatars/${req.file.filename}` : null;
  await pool.query(
    'INSERT INTO news (author_id, title, content, image_url) VALUES ($1,$2,$3,$4)',
    [req.user.id, title, content, image_url]
  );
  res.redirect('/news');
});

app.post('/news/:id/delete', auth(['reporter','admin']), async (req, res) => {
  const article = await dbGet('SELECT * FROM news WHERE id=?', [req.params.id]);
  if (article && (req.user.role === 'admin' || article.author_id === req.user.id)) {
    await pool.query('DELETE FROM news WHERE id=$1', [req.params.id]);
  }
  res.redirect('/news');
});

app.get('/news/:id', async (req, res) => {
  const article = await dbGet(`
    SELECT n.*, u.full_name AS author_name, u.avatar AS author_avatar, u.role AS author_role
    FROM news n JOIN users u ON n.author_id=u.id WHERE n.id=?`, [req.params.id]);
  if (!article) return res.status(404).send('Новость не найдена');
  res.render('news-article', { article });
});


// ── Notification badges API ───────────────────────────────────────────────────
app.get('/api/notifications', auth(), async (req, res) => {
  const uid = req.user.id;
  // Unread messages across all chats
  const unreadMsgs = await pool.query(`
    SELECT COUNT(*) AS count FROM messages m
    JOIN chats c ON m.chat_id=c.id
    WHERE (c.user_a_id=$1 OR c.user_b_id=$1)
      AND m.sender_id!=$1 AND m.is_read=0
  `, [uid]).then(r => parseInt(r.rows[0].count));

  // Unread news (news published after user's last visit — we use a simple approach:
  // count news newer than user's last seen news timestamp stored client-side)
  // Since we don't track per-user news reads on server, return total unread via localStorage key on client
  const latestNewsCount = await pool.query(`
    SELECT COUNT(*) AS count FROM news WHERE created_at > NOW() - INTERVAL '7 days'
  `).then(r => parseInt(r.rows[0].count));

  res.json({ messages: unreadMsgs, news: latestNewsCount });
});

// ── Delete message ────────────────────────────────────────────────────────────
app.delete('/messages/:id', auth(), async (req, res) => {
  const msg = await dbGet('SELECT * FROM messages WHERE id=?', [req.params.id]);
  if (!msg) return res.status(404).json({ error: 'Не найдено' });
  // Any participant of the chat can delete any message in their chat
  const chat = await dbGet('SELECT * FROM chats WHERE id=?', [msg.chat_id]);
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });
  const uid = req.user.id;
  if (chat.user_a_id !== uid && chat.user_b_id !== uid && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Нет доступа' });
  }
  await pool.query('DELETE FROM messages WHERE id=$1', [req.params.id]);
  res.json({ ok: true, messageId: req.params.id, chatId: msg.chat_id });
});

// ── Review moderation ─────────────────────────────────────────────────────────
app.post('/admin/reviews/:id/approve', auth(['admin']), async (req, res) => {
  await pool.query("UPDATE reviews SET moderation_status='approved' WHERE id=$1", [req.params.id]);
  res.redirect('/admin/reviews');
});

// ── Admin helpers ─────────────────────────────────────────────────────────────
async function adminData() {
  const [universities, users, admins, faculties,
         uC, unC, rC, cC] = await Promise.all([
    dbAll('SELECT * FROM universities ORDER BY name'),
    dbAll("SELECT * FROM users ORDER BY created_at DESC"),
    dbAll("SELECT * FROM users WHERE role='admin' ORDER BY full_name"),
    dbAll('SELECT f.*,u.name AS university_name FROM faculties f LEFT JOIN universities u ON f.university_id=u.id ORDER BY u.name,f.name'),
    dbGet('SELECT COUNT(*) AS count FROM users'),
    dbGet('SELECT COUNT(*) AS count FROM universities'),
    dbGet('SELECT COUNT(*) AS count FROM reviews'),
    dbGet('SELECT COUNT(*) AS count FROM chats'),
  ]);
  return { universities, users, admins, faculties,
    stats: { totalUsers: uC.count, totalUniversities: unC.count, totalReviews: rC.count, totalChats: cC.count } };
}

// ── Admin routes ──────────────────────────────────────────────────────────────
app.get('/admin', auth(['admin']), async (req, res) =>
  res.render('admin', { ...(await adminData()), error: null, success: null }));

app.post('/admin/universities', auth(['admin']), async (req, res) => {
  await pool.query('INSERT INTO universities (name,city,description) VALUES ($1,$2,$3)',
    [req.body.name, req.body.city||null, req.body.description||null]);
  res.redirect('/admin#universities');
});
app.get('/admin/universities/:id/edit', auth(['admin']), async (req, res) => {
  const university = await dbGet('SELECT * FROM universities WHERE id=?', [req.params.id]);
  if (!university) return res.redirect('/admin');
  res.render('admin-university-edit', { university });
});
app.post('/admin/universities/:id/edit', auth(['admin']), async (req, res) => {
  await pool.query('UPDATE universities SET name=$1,city=$2,description=$3 WHERE id=$4',
    [req.body.name, req.body.city||null, req.body.description||null, req.params.id]);
  res.redirect('/admin#universities');
});
app.post('/admin/universities/:id/delete', auth(['admin']), async (req, res) => {
  await pool.query('DELETE FROM universities WHERE id=$1', [req.params.id]);
  res.redirect('/admin#universities');
});

app.post('/admin/faculties', auth(['admin']), async (req, res) => {
  await pool.query('INSERT INTO faculties (university_id,name,description) VALUES ($1,$2,$3)',
    [req.body.university_id, req.body.name, req.body.description||null]);
  res.redirect('/admin#faculties');
});
app.get('/admin/faculties/:id/edit', auth(['admin']), async (req, res) => {
  const faculty      = await dbGet('SELECT * FROM faculties WHERE id=?', [req.params.id]);
  if (!faculty) return res.redirect('/admin');
  const universities = await dbAll('SELECT * FROM universities ORDER BY name');
  res.render('admin-faculty-edit', { faculty, universities });
});
app.post('/admin/faculties/:id/edit', auth(['admin']), async (req, res) => {
  await pool.query('UPDATE faculties SET university_id=$1,name=$2,description=$3 WHERE id=$4',
    [req.body.university_id, req.body.name, req.body.description||null, req.params.id]);
  res.redirect('/admin#faculties');
});
app.post('/admin/faculties/:id/delete', auth(['admin']), async (req, res) => {
  await pool.query('DELETE FROM faculties WHERE id=$1', [req.params.id]);
  res.redirect('/admin#faculties');
});

app.post('/admin/users/:id/role', auth(['admin']), async (req, res) => {
  await pool.query('UPDATE users SET role=$1 WHERE id=$2', [req.body.role, req.params.id]);
  res.redirect('/admin#users');
});

app.post('/admin/make-admin', auth(['admin']), async (req, res) => {
  const match = (req.body.profile_url || '').match(/\/user\/(\d+)/);
  if (!match) return res.render('admin', { ...(await adminData()), error: 'Неверная ссылка. Формат: /user/5', success: null });
  const target = await dbGet('SELECT * FROM users WHERE id=?', [parseInt(match[1])]);
  if (!target) return res.render('admin', { ...(await adminData()), error: `Пользователь #${match[1]} не найден`, success: null });
  await pool.query('UPDATE users SET role=$1 WHERE id=$2', ['admin', target.id]);
  res.render('admin', { ...(await adminData()), success: `${target.full_name} назначен администратором`, error: null });
});

app.post('/admin/make-admin-by-email', auth(['admin']), async (req, res) => {
  const email  = (req.body.email||'').trim().toLowerCase();
  const target = await pool.query('SELECT * FROM users WHERE LOWER(email)=$1', [email]).then(r=>r.rows[0]);
  if (!target) return res.render('admin', { ...(await adminData()), error: `Email "${email}" не найден`, success: null });
  await pool.query('UPDATE users SET role=$1 WHERE id=$2', ['admin', target.id]);
  res.render('admin', { ...(await adminData()), success: `${target.full_name} назначен администратором`, error: null });
});

app.get('/admin/reviews', auth(['admin']), async (req, res) => {
  const reviews = await dbAll(`
    SELECT r.*, u.full_name AS user_name, un.name AS university_name, f.name AS faculty_name
    FROM reviews r JOIN users u ON r.user_id=u.id
    JOIN universities un ON r.university_id=un.id
    LEFT JOIN faculties f ON r.faculty_id=f.id
    ORDER BY r.created_at DESC`);
  res.render('admin-reviews', { reviews });
});
app.post('/admin/reviews/:id/delete', auth(), async (req, res) => {
  const review = await dbGet('SELECT * FROM reviews WHERE id=?', [req.params.id]);
  if (req.user.role === 'admin' || (review && review.user_id === req.user.id))
    await pool.query('DELETE FROM reviews WHERE id=$1', [req.params.id]);
  res.redirect(req.body.redirect || '/admin/reviews');
});

// ── DB Reset (admin only) ─────────────────────────────────────────────────────
app.post('/admin/reset-db', auth(['admin']), async (req, res) => {
  if (req.body.confirm !== 'УДАЛИТЬ') {
    return res.render('admin', { ...(await adminData()), error: 'Введите УДАЛИТЬ для подтверждения', success: null });
  }
  // Drop all data but keep tables and the current admin account
  const currentAdmin = await dbGet('SELECT * FROM users WHERE id=?', [req.user.id]);
  await pool.query(`
    TRUNCATE messages, chats, reviews, student_profiles, faculties, universities, users RESTART IDENTITY CASCADE;
  `);
  // Re-insert the admin who pressed the button
  await pool.query(
    'INSERT INTO users (email,password,full_name,role,avatar) VALUES ($1,$2,$3,$4,$5)',
    [currentAdmin.email, currentAdmin.password, currentAdmin.full_name, 'admin', currentAdmin.avatar]
  );
  // Re-sign token with new id=1
  const newAdmin = await pool.query('SELECT id FROM users LIMIT 1').then(r=>r.rows[0]);
  const token    = jwt.sign({ id: newAdmin.id, email: currentAdmin.email, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, { httpOnly: true, maxAge: 7*24*60*60*1000 });
  res.redirect('/admin?reset=ok');
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  await initDB();
  const server = http.createServer(app);
  const io     = socketIo(server);

  io.on('connection', socket => {
    socket.on('join_chat', chatId => socket.join(`chat_${chatId}`));
    socket.on('send_message', async ({ chatId, senderId, content }) => {
      const ins = await pool.query(
        'INSERT INTO messages (chat_id,sender_id,content) VALUES ($1,$2,$3) RETURNING id',
        [chatId, senderId, content]
      );
      const msg = await pool.query(
        'SELECT m.*,u.full_name,u.avatar FROM messages m JOIN users u ON m.sender_id=u.id WHERE m.id=$1',
        [ins.rows[0].id]
      ).then(r=>r.rows[0]);
      io.to(`chat_${chatId}`).emit('new_message', msg);
    });
    // Broadcast message deletion to chat room
    socket.on('delete_message', ({ messageId, chatId }) => {
      io.to(`chat_${chatId}`).emit('message_deleted', { messageId });
    });
  });

  server.listen(PORT, () => console.log(`🚀 UniTalk запущен на порту ${PORT}`));
}
start().catch(err => { console.error('❌', err); process.exit(1); });
