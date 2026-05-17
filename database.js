const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'unitalk.db');

let db = null;

async function getDatabase() {
  if (db) return db;
  
  const SQL = await initSqlJs();
  
  // Загружаем существующую БД или создаем новую
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }
  
  // Создание таблиц
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('applicant', 'student', 'admin')),
      full_name TEXT NOT NULL,
      avatar TEXT DEFAULT '/avatars/default.png',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS universities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      city TEXT,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS faculties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      university_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      FOREIGN KEY (university_id) REFERENCES universities(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS student_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL,
      university_id INTEGER,
      faculty_id INTEGER,
      course INTEGER CHECK(course BETWEEN 1 AND 6),
      graduation_year INTEGER,
      bio TEXT,
      is_available INTEGER DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (university_id) REFERENCES universities(id) ON DELETE SET NULL,
      FOREIGN KEY (faculty_id) REFERENCES faculties(id) ON DELETE SET NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      university_id INTEGER NOT NULL,
      faculty_id INTEGER,
      rating INTEGER CHECK(rating BETWEEN 1 AND 5),
      content TEXT NOT NULL,
      is_anonymous INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (university_id) REFERENCES universities(id) ON DELETE CASCADE,
      FOREIGN KEY (faculty_id) REFERENCES faculties(id) ON DELETE SET NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      applicant_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (applicant_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(applicant_id, student_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Создаем индексы
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_reviews_university_id ON reviews(university_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_chats_applicant ON chats(applicant_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_chats_student ON chats(student_id)`);
  
  return db;
}

// Сохранение БД в файл
function saveDatabase() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

// Автосохранение каждые 30 секунд
setInterval(saveDatabase, 30000);

// Сохранение при выходе
process.on('exit', saveDatabase);
process.on('SIGINT', () => { saveDatabase(); process.exit(); });

// Обертка для совместимости со старым кодом
const dbWrapper = {
  prepare: (sql) => {
    return {
      get: (...params) => {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        if (stmt.step()) {
          const columns = stmt.getColumnNames();
          const values = stmt.get();
          const obj = {};
          columns.forEach((col, i) => obj[col] = values[i]);
          stmt.free();
          return obj;
        }
        stmt.free();
        return undefined;
      },
      all: (...params) => {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        const results = [];
        const columns = stmt.getColumnNames();
        while (stmt.step()) {
          const values = stmt.get();
          const obj = {};
          columns.forEach((col, i) => obj[col] = values[i]);
          results.push(obj);
        }
        stmt.free();
        return results;
      },
      run: (...params) => {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        stmt.step();
        const lastId = db.exec("SELECT last_insert_rowid() as id")[0]?.values[0][0];
        const changes = db.getRowsModified();
        stmt.free();
        saveDatabase();
        return { lastInsertRowid: lastId, changes };
      }
    };
  },
  exec: (sql) => {
    db.run(sql);
    saveDatabase();
  },
  pragma: (pragma) => {
    db.run(`PRAGMA ${pragma}`);
  }
};

module.exports = dbWrapper;