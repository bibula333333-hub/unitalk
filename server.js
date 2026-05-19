// v2.0 - nav partials
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const path = require('path');
const initSqlJs = require('sql.js');
const fs = require('fs');

const app = express();

const JWT_SECRET = 'your-secret-key-change-in-production';
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'unitalk.db');

let db;

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  return db;
}

function saveDb() {
  if (db) fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const cols = stmt.getColumnNames();
    const vals = stmt.get();
    const obj = {};
    cols.forEach((c, i) => obj[c] = vals[i]);
    stmt.free();
    return obj;
  }
  stmt.free();
  return undefined;
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  const cols = stmt.getColumnNames();
  while (stmt.step()) {
    const vals = stmt.get();
    const obj = {};
    cols.forEach((c, i) => obj[c] = vals[i]);
    results.push(obj);
  }
  stmt.free();
  return results;
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDb();
  return { lastInsertRowid: db.exec("SELECT last_insert_rowid()")[0]?.values[0][0] };
}

function dbExec(sql) {
  db.run(sql);
  saveDb();
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// Layout middleware: wrap all views with layout.ejs
app.use((req, res, next) => {
  const originalRender = res.render.bind(res);
  res.render = function(view, options, callback) {
    const opts = (typeof options === 'object' ? options : {}) || {};
    originalRender(view, opts, (err, body) => {
      if (err) return next(err);
      originalRender('layout', { ...opts, body }, callback || ((err2, html) => {
        if (err2) return next(err2);
        res.send(html);
      }));
    });
  };
  next();
});

const storage = multer.diskStorage({
  destination: './public/avatars/',
  filename: (req, file, cb) => {
    cb(null, `avatar-${Date.now()}${path.extname(file.originalname)}`);
  }
});
const upload = multer({ storage });

const auth = (roles = []) => {
  return (req, res, next) => {
    const token = req.cookies.token;
    if (!token) return res.redirect('/login');
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      if (roles.length && !roles.includes(decoded.role)) {
        return res.status(403).send('Доступ запрещен');
      }
      next();
    } catch (err) {
      res.clearCookie('token');
      return res.redirect('/login');
    }
  };
};

app.use((req, res, next) => {
  const token = req.cookies.token;
  if (token) {
    try {
      res.locals.user = dbGet('SELECT * FROM users WHERE id = ?', [jwt.verify(token, JWT_SECRET).id]);
    } catch (err) {
      res.locals.user = null;
    }
  } else {
    res.locals.user = null;
  }
  next();
});

app.get('/', (req, res) => {
  const universities = dbAll('SELECT * FROM universities ORDER BY name');
  const recentReviews = dbAll(`
    SELECT r.*, u.full_name, un.name as university_name, f.name as faculty_name
    FROM reviews r
    JOIN users u ON r.user_id = u.id
    JOIN universities un ON r.university_id = un.id
    LEFT JOIN faculties f ON r.faculty_id = f.id
    ORDER BY r.created_at DESC
    LIMIT 10
  `);
  res.render('index', { universities, recentReviews });
});

app.get('/register', (req, res) => {
  res.render('register', { error: null });
});

app.post('/register', async (req, res) => {
  const { email, password, full_name, role } = req.body;
  const existing = dbGet('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) return res.render('register', { error: 'Email уже зарегистрирован' });
  const hashedPassword = await bcrypt.hash(password, 10);
  dbRun('INSERT INTO users (email, password, full_name, role) VALUES (?, ?, ?, ?)', 
    [email, hashedPassword, full_name, role]);
  const user = dbGet('SELECT id FROM users WHERE email = ?', [email]);
  const token = jwt.sign({ id: user.id, email, role }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
  res.redirect('/');
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = dbGet('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.render('login', { error: 'Неверный email или пароль' });
  }
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  res.clearCookie('token');
  res.redirect('/');
});

app.get('/profile', auth(), (req, res) => {
  const user = dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
  let studentProfile = null;
  if (user.role === 'student') {
    studentProfile = dbGet(`
      SELECT sp.*, u.name as university_name, f.name as faculty_name
      FROM student_profiles sp
      LEFT JOIN universities u ON sp.university_id = u.id
      LEFT JOIN faculties f ON sp.faculty_id = f.id
      WHERE sp.user_id = ?
    `, [user.id]);
  }
  const universities = dbAll('SELECT * FROM universities ORDER BY name');
  res.render('profile', { user, studentProfile, universities, error: null });
});

app.post('/profile', auth(), upload.single('avatar'), (req, res) => {
  if (req.file) {
    dbRun('UPDATE users SET avatar = ? WHERE id = ?', [`/avatars/${req.file.filename}`, req.user.id]);
  }
  if (req.user.role === 'student') {
    const { university_id, faculty_id, course, graduation_year, bio } = req.body;
    const existing = dbGet('SELECT id FROM student_profiles WHERE user_id = ?', [req.user.id]);
    if (existing) {
      dbRun('UPDATE student_profiles SET university_id=?, faculty_id=?, course=?, graduation_year=?, bio=? WHERE user_id=?',
        [university_id || null, faculty_id || null, course || null, graduation_year || null, bio || null, req.user.id]);
    } else {
      dbRun('INSERT INTO student_profiles (user_id, university_id, faculty_id, course, graduation_year, bio) VALUES (?,?,?,?,?,?)',
        [req.user.id, university_id || null, faculty_id || null, course || null, graduation_year || null, bio || null]);
    }
  }
  res.redirect('/profile');
});

// Публичный профиль пользователя
app.get('/user/:id', auth(), (req, res) => {
  const profileUser = dbGet('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!profileUser) return res.status(404).send('Пользователь не найден');
  let studentProfile = null;
  if (profileUser.role === 'student') {
    studentProfile = dbGet(`
      SELECT sp.*, u.name as university_name, f.name as faculty_name
      FROM student_profiles sp
      LEFT JOIN universities u ON sp.university_id = u.id
      LEFT JOIN faculties f ON sp.faculty_id = f.id
      WHERE sp.user_id = ?
    `, [profileUser.id]);
  }
  res.render('user-profile', { profileUser, studentProfile });
});

app.get('/api/faculties/:universityId', (req, res) => {
  res.json(dbAll('SELECT * FROM faculties WHERE university_id = ? ORDER BY name', [req.params.universityId]));
});

app.get('/universities', (req, res) => {
  const universities = dbAll(`
    SELECT u.*, COUNT(DISTINCT r.id) as review_count, ROUND(AVG(r.rating), 1) as avg_rating
    FROM universities u LEFT JOIN reviews r ON u.id = r.university_id
    GROUP BY u.id ORDER BY u.name
  `);
  res.render('universities', { universities });
});

app.get('/universities/:id', (req, res) => {
  const university = dbGet('SELECT * FROM universities WHERE id = ?', [req.params.id]);
  if (!university) return res.status(404).send('Вуз не найден');
  const faculties = dbAll('SELECT * FROM faculties WHERE university_id = ? ORDER BY name', [req.params.id]);
  const reviews = dbAll(`
    SELECT r.*, u.full_name, u.avatar, CASE WHEN r.is_anonymous THEN 'Аноним' ELSE u.full_name END as display_name, f.name as faculty_name
    FROM reviews r JOIN users u ON r.user_id = u.id LEFT JOIN faculties f ON r.faculty_id = f.id
    WHERE r.university_id = ? ORDER BY r.created_at DESC
  `, [req.params.id]);
  res.render('university', { university, faculties, reviews, error: null });
});

app.post('/universities/:id/review', auth(), (req, res) => {
  const { faculty_id, rating, content, is_anonymous } = req.body;
  dbRun('INSERT INTO reviews (user_id, university_id, faculty_id, rating, content, is_anonymous) VALUES (?,?,?,?,?,?)',
    [req.user.id, req.params.id, faculty_id || null, rating, content, is_anonymous ? 1 : 0]);
  res.redirect(`/universities/${req.params.id}`);
});

app.get('/chats', auth(), (req, res) => {
  let chats;
  if (req.user.role === 'student') {
    // Student can be both initiator and receiver
    chats = dbAll(`
      SELECT c.*,
        CASE WHEN c.student_id=? THEN u1.full_name ELSE u2.full_name END as full_name,
        CASE WHEN c.student_id=? THEN u1.avatar ELSE u2.avatar END as avatar,
        (SELECT COUNT(*) FROM messages WHERE chat_id=c.id AND sender_id!=? AND is_read=0) as unread_count,
        (SELECT content FROM messages WHERE chat_id=c.id ORDER BY created_at DESC LIMIT 1) as last_message
      FROM chats c
      JOIN users u1 ON c.applicant_id=u1.id
      JOIN users u2 ON c.student_id=u2.id
      WHERE c.student_id=? OR c.applicant_id=?
      ORDER BY (SELECT MAX(created_at) FROM messages WHERE chat_id=c.id) DESC
    `, [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id]);
  } else {
    chats = dbAll(`
      SELECT c.*, u.full_name, u.avatar,
        (SELECT COUNT(*) FROM messages WHERE chat_id=c.id AND sender_id!=? AND is_read=0) as unread_count,
        (SELECT content FROM messages WHERE chat_id=c.id ORDER BY created_at DESC LIMIT 1) as last_message
      FROM chats c JOIN users u ON c.student_id=u.id
      WHERE c.applicant_id=? ORDER BY (SELECT MAX(created_at) FROM messages WHERE chat_id=c.id) DESC
    `, [req.user.id, req.user.id]);
  }
  const students = dbAll(`
    SELECT u.id, u.full_name, u.avatar, sp.bio, un.name as university_name, f.name as faculty_name, sp.course
    FROM users u JOIN student_profiles sp ON u.id=sp.user_id
    LEFT JOIN universities un ON sp.university_id=un.id
    LEFT JOIN faculties f ON sp.faculty_id=f.id
    WHERE u.role='student' AND sp.is_available=1 AND u.id!=?
  `, [req.user.id]);
  res.render('chats', { chats, students, role: req.user.role, user: res.locals.user });
});

app.post('/chats/start/:studentId', auth(), (req, res) => {
  const targetId = parseInt(req.params.studentId);
  const myId = req.user.id;
  // Check both directions
  let chat = dbGet('SELECT id FROM chats WHERE (applicant_id=? AND student_id=?) OR (applicant_id=? AND student_id=?)',
    [myId, targetId, targetId, myId]);
  if (!chat) {
    dbRun('INSERT INTO chats (applicant_id, student_id) VALUES (?,?)', [myId, targetId]);
    chat = dbGet('SELECT id FROM chats WHERE applicant_id=? AND student_id=?', [myId, targetId]);
  }
  res.redirect(`/chats/${chat.id}`);
});

app.get('/chats/:id', auth(), (req, res) => {
  const chat = dbGet('SELECT * FROM chats WHERE id=?', [req.params.id]);
  if (!chat) return res.status(404).send('Чат не найден');
  if (chat.applicant_id !== req.user.id && chat.student_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).send('Доступ запрещен');
  }
  const partnerId = req.user.id === chat.applicant_id ? chat.student_id : chat.applicant_id;
  const partner = dbGet('SELECT * FROM users WHERE id=?', [partnerId]);
  const messages = dbAll(`
    SELECT m.*, u.full_name, u.avatar FROM messages m JOIN users u ON m.sender_id=u.id
    WHERE m.chat_id=? ORDER BY m.created_at ASC LIMIT 100
  `, [req.params.id]);
  dbRun('UPDATE messages SET is_read=1 WHERE chat_id=? AND sender_id!=? AND is_read=0', [req.params.id, req.user.id]);
  res.render('chat', { chat, partner, messages });
});

function getAdminPageData() {
  return {
    universities: dbAll('SELECT * FROM universities ORDER BY name'),
    users: dbAll('SELECT * FROM users ORDER BY created_at DESC'),
    admins: dbAll("SELECT * FROM users WHERE role='admin' ORDER BY full_name"),
    faculties: dbAll(`SELECT f.*, u.name as university_name FROM faculties f LEFT JOIN universities u ON f.university_id=u.id ORDER BY u.name, f.name`),
    stats: {
      totalUsers: dbGet('SELECT COUNT(*) as count FROM users').count,
      totalUniversities: dbGet('SELECT COUNT(*) as count FROM universities').count,
      totalReviews: dbGet('SELECT COUNT(*) as count FROM reviews').count,
      totalChats: dbGet('SELECT COUNT(*) as count FROM chats').count,
    }
  };
}

app.get('/admin', auth(['admin']), (req, res) => {
  res.render('admin', { ...getAdminPageData(), error: null, success: null });
});

app.post('/admin/universities', auth(['admin']), (req, res) => {
  dbRun('INSERT INTO universities (name, city, description) VALUES (?,?,?)', [req.body.name, req.body.city || null, req.body.description || null]);
  res.redirect('/admin#universities');
});

app.get('/admin/universities/:id/edit', auth(['admin']), (req, res) => {
  const university = dbGet('SELECT * FROM universities WHERE id=?', [req.params.id]);
  if (!university) return res.redirect('/admin');
  res.render('admin-university-edit', { university });
});

app.post('/admin/universities/:id/edit', auth(['admin']), (req, res) => {
  dbRun('UPDATE universities SET name=?, city=?, description=? WHERE id=?',
    [req.body.name, req.body.city || null, req.body.description || null, req.params.id]);
  res.redirect('/admin#universities');
});

app.post('/admin/universities/:id/delete', auth(['admin']), (req, res) => {
  dbRun('DELETE FROM universities WHERE id=?', [req.params.id]);
  res.redirect('/admin#universities');
});

app.post('/admin/faculties', auth(['admin']), (req, res) => {
  dbRun('INSERT INTO faculties (university_id, name, description) VALUES (?,?,?)', [req.body.university_id, req.body.name, req.body.description || null]);
  res.redirect('/admin#faculties');
});

app.get('/admin/faculties/:id/edit', auth(['admin']), (req, res) => {
  const faculty = dbGet('SELECT * FROM faculties WHERE id=?', [req.params.id]);
  if (!faculty) return res.redirect('/admin');
  const universities = dbAll('SELECT * FROM universities ORDER BY name');
  res.render('admin-faculty-edit', { faculty, universities });
});

app.post('/admin/faculties/:id/edit', auth(['admin']), (req, res) => {
  dbRun('UPDATE faculties SET university_id=?, name=?, description=? WHERE id=?',
    [req.body.university_id, req.body.name, req.body.description || null, req.params.id]);
  res.redirect('/admin#faculties');
});

app.post('/admin/faculties/:id/delete', auth(['admin']), (req, res) => {
  dbRun('DELETE FROM faculties WHERE id=?', [req.params.id]);
  res.redirect('/admin#faculties');
});

app.post('/admin/users/:id/role', auth(['admin']), (req, res) => {
  dbRun('UPDATE users SET role=? WHERE id=?', [req.body.role, req.params.id]);
  res.redirect('/admin#users');
});

// Назначить администратора по ссылке на профиль
app.post('/admin/make-admin', auth(['admin']), (req, res) => {
  const url = req.body.profile_url || '';
  const match = url.match(/\/user\/(\d+)/);
  if (!match) {
    return res.render('admin', { ...getAdminPageData(), error: 'Неверная ссылка. Формат: /user/5 или полный URL с /user/5', success: null });
  }
  const userId = parseInt(match[1]);
  const target = dbGet('SELECT * FROM users WHERE id=?', [userId]);
  if (!target) {
    return res.render('admin', { ...getAdminPageData(), error: `Пользователь с ID ${userId} не найден`, success: null });
  }
  dbRun('UPDATE users SET role=? WHERE id=?', ['admin', userId]);
  res.render('admin', { ...getAdminPageData(), success: `${target.full_name} назначен администратором`, error: null });
});

// Назначить администратора по email
app.post('/admin/make-admin-by-email', auth(['admin']), (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const target = dbGet('SELECT * FROM users WHERE LOWER(email)=?', [email]);
  if (!target) {
    return res.render('admin', { ...getAdminPageData(), error: `Пользователь с email "${email}" не найден`, success: null });
  }
  dbRun('UPDATE users SET role=? WHERE id=?', ['admin', target.id]);
  res.render('admin', { ...getAdminPageData(), success: `${target.full_name} назначен администратором`, error: null });
});

app.post('/admin/reviews/:id/delete', auth(), (req, res) => {
  const review = dbGet('SELECT * FROM reviews WHERE id = ?', [req.params.id]);
  if (req.user.role === 'admin' || (review && review.user_id === req.user.id)) {
    dbRun('DELETE FROM reviews WHERE id = ?', [req.params.id]);
  }
  const redirect = req.body.redirect || '/admin/reviews';
  res.redirect(redirect);
});

app.get('/admin/reviews', auth(['admin']), (req, res) => {
  const reviews = dbAll(`
    SELECT r.*, u.full_name as user_name, un.name as university_name, 
           f.name as faculty_name
    FROM reviews r
    JOIN users u ON r.user_id = u.id
    JOIN universities un ON r.university_id = un.id
    LEFT JOIN faculties f ON r.faculty_id = f.id
    ORDER BY r.created_at DESC
  `);
  res.render('admin-reviews', { reviews });
});

async function start() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  
  dbExec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('applicant','student','admin')), full_name TEXT NOT NULL, avatar TEXT DEFAULT '/avatars/default.png', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS universities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, city TEXT, description TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS faculties (id INTEGER PRIMARY KEY AUTOINCREMENT, university_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT, FOREIGN KEY(university_id) REFERENCES universities(id));
    CREATE TABLE IF NOT EXISTS student_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE NOT NULL, university_id INTEGER, faculty_id INTEGER, course INTEGER, graduation_year INTEGER, bio TEXT, is_available INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, university_id INTEGER NOT NULL, faculty_id INTEGER, rating INTEGER, content TEXT NOT NULL, is_anonymous INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY AUTOINCREMENT, applicant_id INTEGER NOT NULL, student_id INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(applicant_id, student_id));
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, sender_id INTEGER NOT NULL, content TEXT NOT NULL, is_read INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)
  `);

  const server = http.createServer(app);
  const io = socketIo(server);

  io.on('connection', (socket) => {
    socket.on('join_chat', (chatId) => socket.join(`chat_${chatId}`));
    socket.on('send_message', (data) => {
      dbRun('INSERT INTO messages (chat_id, sender_id, content) VALUES (?,?,?)', [data.chatId, data.senderId, data.content]);
      const msg = dbGet('SELECT m.*, u.full_name, u.avatar FROM messages m JOIN users u ON m.sender_id=u.id WHERE m.id = (SELECT MAX(id) FROM messages)');
      io.to(`chat_${data.chatId}`).emit('new_message', msg);
    });
  });

  server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
}

start();