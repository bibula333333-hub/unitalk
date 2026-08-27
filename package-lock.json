# 🚀 Инструкция по деплою UniTalk на Render с PostgreSQL

## Что изменилось в v3.0

- **База данных:** переход с `sql.js` (SQLite в памяти) на **PostgreSQL** — данные не теряются при перезапуске
- **Чаты:** теперь любой пользователь может написать любому другому
- **Сброс БД:** кнопка в админ-панели (раздел внизу страницы)

---

## Шаг 1 — Подготовка проекта в Git

### 1.1 Инициализируйте репозиторий (если ещё нет)
```bash
cd unitalk
git init
git add .
git commit -m "v3.0 — PostgreSQL database"
```

### 1.2 Создайте репозиторий на GitHub
1. Зайдите на https://github.com → **New repository**
2. Название: `unitalk` (без галочки «Add README»)
3. Нажмите **Create repository**

### 1.3 Привяжите и запушьте
```bash
git remote add origin https://github.com/ВАШ_ЛОГИН/unitalk.git
git branch -M main
git push -u origin main
```

> **Важно:** файл `.env` никогда не пушьте в Git — он уже в `.gitignore`

---

## Шаг 2 — Создание PostgreSQL базы на Render

1. Зайдите на https://render.com → войдите или зарегистрируйтесь
2. Нажмите **New +** → выберите **PostgreSQL**
3. Заполните:
   - **Name:** `unitalk-db`
   - **Database:** `unitalk`
   - **User:** `unitalk_user`
   - **Region:** выберите ближайший (Frankfurt для России)
   - **Plan:** Free
4. Нажмите **Create Database**
5. Подождите ~1 минуту, пока база создаётся
6. **Скопируйте** значение поля **Internal Database URL** — оно выглядит так:
   ```
   postgresql://unitalk_user:ПАРОЛЬ@dpg-xxxxxx-a/unitalk
   ```

---

## Шаг 3 — Создание Web Service на Render

1. Нажмите **New +** → **Web Service**
2. Выберите **Build and deploy from a Git repository**
3. Подключите GitHub и выберите репозиторий `unitalk`
4. Заполните настройки:
   - **Name:** `unitalk`
   - **Region:** тот же, что у базы
   - **Branch:** `main`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
5. Раскройте блок **Environment Variables** и добавьте:

   | Key | Value |
   |-----|-------|
   | `DATABASE_URL` | Internal Database URL из шага 2 |
   | `JWT_SECRET` | Любая длинная строка, например: `UniTalk_Super_Secret_2025_XyZ!` |
   | `NODE_ENV` | `production` |

6. Нажмите **Create Web Service**

Render сам установит зависимости, запустит сервер и создаст все таблицы.

---

## Шаг 4 — Создание администратора

После деплоя откройте ваш сайт и зарегистрируйтесь.
Затем в настройках Render откройте **Shell** вашего сервиса и выполните:

```bash
node -e "
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function run() {
  const hash = await bcrypt.hash('ВАШ_ПАРОЛЬ', 10);
  await pool.query(\"UPDATE users SET role='admin' WHERE email='\$1'\", ['ВАШ_EMAIL']);
  console.log('Готово!');
  process.exit(0);
}
run();
"
```

Или просто зарегистрируйтесь на сайте, а потом через Render Shell выполните:
```bash
node -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.query(\"UPDATE users SET role='admin' WHERE email='ВАШ_EMAIL'\").then(() => { console.log('OK'); process.exit(); });
"
```

---

## Обновление сайта

После изменений в коде:
```bash
git add .
git commit -m "описание изменений"
git push
```
Render автоматически задеплоит новую версию через ~2 минуты.

---

## Локальный запуск

### Установите PostgreSQL локально (или используйте Docker):
```bash
# Docker (проще всего):
docker run --name unitalk-pg -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=unitalk -p 5432:5432 -d postgres

# Или установите PostgreSQL нативно для вашей ОС
```

### Создайте `.env` файл:
```
DATABASE_URL=postgresql://postgres:secret@localhost:5432/unitalk
JWT_SECRET=local-dev-secret
NODE_ENV=development
PORT=3000
```

### Запустите:
```bash
npm install
npm run dev
```

Сайт будет доступен на http://localhost:3000

---

## Структура базы данных

```
users               — все пользователи (applicant / student / admin)
universities        — вузы с описанием и городом
faculties           — факультеты, привязанные к вузам
student_profiles    — профили студентов (вуз, курс, bio)
reviews             — отзывы пользователей о вузах
chats               — диалоги между любыми двумя пользователями
messages            — сообщения в чатах (real-time через Socket.IO)
```
