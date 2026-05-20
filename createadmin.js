/**
 * Скрипт создания Главного администратора (is_main_admin = TRUE)
 * Запуск локально:  node createadmin.js
 * На Render Shell:  node createadmin.js
 *
 * Переменные окружения (.env или Render Environment Variables):
 *   DATABASE_URL   — строка подключения к PostgreSQL
 *   ADMIN_EMAIL    — email (по умолчанию admin@unitalk.ru)
 *   ADMIN_PASSWORD — пароль (по умолчанию UniTalk@Admin2025)
 */
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');

const EMAIL     = process.env.ADMIN_EMAIL    || 'admin@unitalk.ru';
const PASSWORD  = process.env.ADMIN_PASSWORD || 'UniTalk@Admin2025';
const FULL_NAME = 'Главный Администратор';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL не задан. Добавьте в .env или в переменные окружения Render.');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('render.com') || process.env.DATABASE_URL.includes('amazonaws')
      ? { rejectUnauthorized: false } : false,
  });

  try {
    // Ensure column exists (migration guard)
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN IF NOT EXISTS is_main_admin BOOLEAN DEFAULT FALSE;
      EXCEPTION WHEN others THEN NULL; END $$;
    `).catch(() => {});

    const hash = await bcrypt.hash(PASSWORD, 10);
    const existing = await pool.query('SELECT id FROM users WHERE email=$1', [EMAIL]).then(r => r.rows[0]);

    if (existing) {
      // Restore role + main admin flag without touching anything else
      await pool.query(
        "UPDATE users SET role='admin', is_main_admin=TRUE, password=$1 WHERE email=$2",
        [hash, EMAIL]
      );
      console.log(`✅ Роль и пароль восстановлены для: ${EMAIL}`);
    } else {
      await pool.query(
        'INSERT INTO users (email,password,full_name,role,is_main_admin) VALUES ($1,$2,$3,$4,TRUE)',
        [EMAIL, hash, FULL_NAME, 'admin']
      );
      console.log(`✅ Главный администратор создан: ${EMAIL}`);
    }

    console.log(`🔑 Пароль: ${PASSWORD}`);
    console.log('🔒 Флаг is_main_admin = TRUE — роль никто не сможет изменить через интерфейс');
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error('❌ Ошибка:', err.message); process.exit(1); });
