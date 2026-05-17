const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'unitalk.db');

async function createAdmin() {
  const SQL = await initSqlJs();
  
  let db;
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
    // Создаем таблицу users, если её нет
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
  }

  const hashedPassword = await bcrypt.hash('admin123', 10);

  try {
    db.run(
      'INSERT INTO users (email, password, full_name, role) VALUES (?, ?, ?, ?)',
      ['admin@unitalk.ru', hashedPassword, 'Администратор', 'admin']
    );
    
    // Сохраняем БД
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
    
    console.log('Админ создан: admin@unitalk.ru / admin123');
  } catch (error) {
    console.log('Ошибка:', error.message);
  }
}

createAdmin();