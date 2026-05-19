/**
 * Скрипт создания/обновления администратора
 * Запуск: node createadmin.js
 * На Render: выполнить в Shell сервиса
 */
require('dotenv').config();
const { Pool }  = require('pg');
const bcrypt    = require('bcryptjs');

const EMAIL     = process.env.ADMIN_EMAIL    || 'admin@unitalk.ru';
const PASSWORD  = process.env.ADMIN_PASSWORD || 'UniTalk@Admin2025';
const FULL_NAME = 'Администратор';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL не задан. Добавьте в .env или передайте через переменную окружения.');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : false,
  });

  const hash = await bcrypt.hash(PASSWORD, 10);

  // Try to update existing user first, else insert
  const existing = await pool.query('SELECT id FROM users WHERE email=$1', [EMAIL]).then(r=>r.rows[0]);
  if (existing) {
    await pool.query('UPDATE users SET password=$1, role=$2 WHERE email=$3', [hash, 'admin', EMAIL]);
    console.log(`✅ Пароль и роль обновлены для ${EMAIL}`);
  } else {
    await pool.query(
      'INSERT INTO users (email,password,full_name,role) VALUES ($1,$2,$3,$4)',
      [EMAIL, hash, FULL_NAME, 'admin']
    );
    console.log(`✅ Администратор создан: ${EMAIL}`);
  }
  console.log(`🔑 Пароль: ${PASSWORD}`);
  await pool.end();
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
