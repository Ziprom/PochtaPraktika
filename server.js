const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const fs = require('fs');
const csrf = require('csurf');
const nodemailer = require('nodemailer');
const moment = require('moment');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.locals.moment = moment;

// ========== ЛОГИРОВАНИЕ В ФАЙЛ ==========
const logFilePath = path.join(__dirname, 'server.log');
const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

function writeToLog(level, ...args) {
    const timestamp = moment().utcOffset(300).format('YYYY-MM-DD HH:mm:ss');
    const message = args.join(' ');
    const line = `[${timestamp}] [${level}] ${message}\n`;
    logStream.write(line);
}

const originalError = console.error;
console.error = (...args) => {
    originalError(...args);
    writeToLog('ERROR', ...args);
};

const originalWarn = console.warn;
console.warn = (...args) => {
    originalWarn(...args);
    writeToLog('WARN', ...args);
};

const originalLog = console.log;
console.log = (...args) => {
    originalLog(...args);
    writeToLog('INFO', ...args);
};

// ========== HELMET ==========
app.use(helmet({
    contentSecurityPolicy: false,
}));

// ========== НАСТРОЙКИ ПОЧТЫ ==========
const IMAP_CONFIG = {
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT) || 993,
    secure: true,
    auth: {
        user: process.env.IMAP_USER,
        pass: process.env.IMAP_PASS
    }
};

// SMTP для отправки ответов
const SMTP_CONFIG = {
    host: process.env.SMTP_HOST || 'smtp.mail.ru',
    port: parseInt(process.env.SMTP_PORT) || 465,
    secure: true,
    auth: { user: process.env.SMTP_USER || process.env.IMAP_USER, pass: process.env.SMTP_PASS || process.env.IMAP_PASS }
};

// ========== БАЗА ДАННЫХ ==========
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error('Ошибка подключения к БД:', err.message);
    else {
        console.log('Подключение к SQLite установлено.');
        db.run('PRAGMA busy_timeout = 10000');
        db.run('PRAGMA journal_mode = WAL');
        db.serialize(() => {
            // Старая таблица писем
            db.run(`CREATE TABLE IF NOT EXISTS feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_email TEXT NOT NULL,
                subject TEXT,
                body_text TEXT,
                email_date DATETIME,
                received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                message_uid TEXT UNIQUE,
                is_read INTEGER DEFAULT 0
            )`);
            // Таблица заявок (tickets)
            db.run(`CREATE TABLE IF NOT EXISTS tickets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_email TEXT,
                organization TEXT,
                subject TEXT,
                email_date DATETIME,
                received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                message_uid TEXT,            -- uid первого письма, если создано из письма
                status TEXT DEFAULT 'open',  -- open, waiting, closed
                category TEXT,
                last_reply_at DATETIME,
                last_reply_from TEXT,
                assigned_to TEXT,
                closed_by TEXT
            )`);
            // Добавляем closed_by, если таблица была создана ранее без этого столбца
            db.run(`ALTER TABLE tickets ADD COLUMN closed_by TEXT`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('Миграция closed_by:', err.message);
                }
            });
            // Сообщения в заявке (чат)
            db.run(`CREATE TABLE IF NOT EXISTS ticket_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticket_id INTEGER NOT NULL,
                from_email TEXT NOT NULL,
                body_text TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                is_internal INTEGER DEFAULT 0,  -- 0=от клиента (письмо), 1=от агента (через чат)
                message_uid TEXT,
                FOREIGN KEY(ticket_id) REFERENCES tickets(id)
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS sync_state (
                key TEXT PRIMARY KEY, value TEXT
            )`);
            db.run(`INSERT OR IGNORE INTO sync_state (key, value) VALUES ('last_uid', '0')`);
            db.run(`CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                display_name TEXT
            )`);

            const ADMIN_USER = process.env.ADMIN_USER || 'admin';
            const ADMIN_PASS = process.env.ADMIN_PASS || 'secret123';

            db.get(`SELECT id FROM users WHERE username = ?`, [ADMIN_USER], async (err, row) => {
                if (err) console.error(err);
                if (!row) {
                    try {
                        const hash = await bcrypt.hash(ADMIN_PASS, 10);
                        db.run(`INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)`,
                            [ADMIN_USER, hash, 'Администратор']);
                        console.log(`✅ Администратор "${ADMIN_USER}" создан.`);
                    } catch (e) { console.error('Ошибка создания администратора:', e); }
                }
            });
            console.log('Таблицы готовы.');
        });
    }
});

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ UID ==========
function getLastUid() {
    return new Promise((resolve, reject) => {
        db.get(`SELECT value FROM sync_state WHERE key = 'last_uid'`, (err, row) => {
            if (err) reject(err);
            else resolve(row ? parseInt(row.value) : 0);
        });
    });
}

function setLastUid(uid) {
    return new Promise((resolve, reject) => {
        db.run(`UPDATE sync_state SET value = ? WHERE key = 'last_uid'`, [uid.toString()], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

// Отправка почты через SMTP
async function sendEmail(to, subject, body, inReplyTo = null, references = null) {
    const transporter = nodemailer.createTransport(SMTP_CONFIG);
    return transporter.sendMail({
        from: process.env.IMAP_USER,
        to, subject, text: body,
        inReplyTo,
        references
    });
}

// ========== ПОЛУЧЕНИЕ ПИСЕМ (с частичным сохранением больших) ==========
let isFetching = false;

async function fetchNewEmails() {
    if (isFetching) {
        console.log('⏳ Проверка уже выполняется, пропускаем...');
        return;
    }
    isFetching = true;

    const BATCH_SIZE = 100;
    const PAUSE_AFTER = 500;
    const LONG_PAUSE_MINUTES = 60;

    let totalProcessedThisSession = 0;
    let shouldLongPause = false;

    try {
        while (true) {
            const client = new ImapFlow({
                ...IMAP_CONFIG,
                logger: false,
                connectionTimeout: 30000,
                socketTimeout: 120000,
                maxIdleTime: 300000
            });

            client.on('error', (err) => {
                console.error('🔌 Ошибка IMAP соединения:', err.message);
            });

            let connected = false;
            let batchProcessed = 0;
            let saved = 0;
            let duplicates = 0;
            let lastUid = 0;
            let maxUid = 0;
            let firstUid = null;

            try {
                console.log('⏳ Подключаемся к почтовому серверу...');
                await client.connect();
                connected = true;
                console.log('📧 Подключено к почтовому ящику');

                const mailbox = await client.mailboxOpen('INBOX');
                console.log(`📬 В ящике ${mailbox.exists} писем`);

                lastUid = await getLastUid();
                console.log(`📌 Начинаем с UID > ${lastUid}`);
                maxUid = lastUid;

                const messages = client.fetch(
                    { all: true },
                    { uid: true, envelope: true, source: true },
                    { uid: true }
                );

                for await (let msg of messages) {
                    const uid = msg.uid;
                    if (uid <= lastUid) continue;

                    if (firstUid === null) firstUid = uid;

                    // Обработка размера письма
                    let sourceForParsing = msg.source;
                    let wasTruncated = false;

                    if (msg.source && msg.source.length > 5 * 1024 * 1024) {
                        console.warn(`⚠️ Письмо UID ${uid} большое (${(msg.source.length / 1024 / 1024).toFixed(2)} МБ), частичное сохранение.`);
                        sourceForParsing = msg.source.slice(0, 10 * 1024 * 1024);
                        wasTruncated = true;
                        client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true }).catch(() => {});
                    }

                    batchProcessed++;
                    totalProcessedThisSession++;
                    maxUid = Math.max(maxUid, uid);

                    if (batchProcessed % 20 === 0) {
                        console.log(`🔄 Обработано ${batchProcessed} писем в этой пачке (UID ${uid})...`);
                    }

                    // Извлечение текста письма
                    let bodyText = '';
                    try {
                        if (!sourceForParsing) throw new Error('Нет source');
                        const parsed = await simpleParser(sourceForParsing);
                        bodyText = parsed.text || '';
                        if (!bodyText && parsed.html) {
                            bodyText = parsed.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
                        }
                        if (!bodyText) bodyText = '[Письмо без текста]';
                        else {
                            if (wasTruncated) {
                                bodyText = '⚠️ Внимание: исходное письмо слишком велико, сохранена только часть содержимого.\n\n' + bodyText;
                            }
                            if (bodyText.length > 5200) {
                                bodyText = bodyText.slice(0, 5200) + '… [обрезано]';
                            }
                        }
                    } catch (e) {
                        console.error(`   ❌ Ошибка парсинга UID ${uid}:`, e.message);
                        bodyText = '[Ошибка обработки]';
                    }

                    // === Создание или обновление заявки ===
                    const from = msg.envelope.from?.[0]?.address || 'unknown';
                    const subject = msg.envelope.subject || '(без темы)';
                    const emailDate = msg.envelope.date
                        ? new Date(msg.envelope.date).toISOString().replace('T', ' ').replace('Z', '').split('.')[0]
                        : null;
                    const inReplyTo = msg.envelope.inReplyTo;
                    const references = msg.envelope.references;

                    let ticketId = null;

                    // 1. Ищем по inReplyTo
                    if (inReplyTo) {
                        await new Promise((resolve) => {
                            db.get(`SELECT id FROM tickets WHERE message_uid = ?`, [inReplyTo], (err, row) => {
                                if (row) ticketId = row.id;
                                resolve();
                            });
                        });
                    }

                    // 2. Если не нашли, ищем по references (цепочка)
                    if (!ticketId && references) {
                        const refList = references.split(/\s+/);
                        for (let ref of refList) {
                            await new Promise((resolve) => {
                                db.get(`SELECT id FROM tickets WHERE message_uid = ?`, [ref], (err, row) => {
                                    if (row) ticketId = row.id;
                                    resolve();
                                });
                            });
                            if (ticketId) break;
                        }
                    }

                    // 3. Если всё ещё не нашли, пробуем извлечь ID из темы [Ticket #N]
                    if (!ticketId) {
                        const match = subject.match(/\[Ticket #(\d+)\]/);
                        if (match) {
                            const possibleId = parseInt(match[1]);
                            await new Promise((resolve) => {
                                db.get(`SELECT id FROM tickets WHERE id = ?`, [possibleId], (err, row) => {
                                    if (row) ticketId = row.id;
                                    resolve();
                                });
                            });
                        }
                    }

                    if (ticketId) {
                        // Найден существующий тикет – добавляем сообщение в чат
                        db.run(
                            `INSERT INTO ticket_messages (ticket_id, from_email, body_text, created_at, is_internal, message_uid)
                             VALUES (?, ?, ?, datetime('now', 'utc'), 0, ?)`,
                            [ticketId, from, bodyText, uid.toString()]
                        );
                        db.run(
                            `UPDATE tickets SET last_reply_at = ?, last_reply_from = ?, status = 'open' WHERE id = ?`,
                            [emailDate, from, ticketId]
                        );
                    } else {
                        // Ищем организацию по email из предыдущих заявок
                        let org = null;
                        if (from) {
                            await new Promise((resolve) => {
                                db.get(
                                    `SELECT organization FROM tickets WHERE from_email = ? AND organization IS NOT NULL ORDER BY id DESC LIMIT 1`,
                                    [from],
                                    (err, row) => {
                                        if (row) org = row.organization;
                                        resolve();
                                    }
                                );
                            });
                        }

                        // Создаём новый тикет с найденной организацией (или без неё)
                        await new Promise((resolve) => {
                            db.run(
                                `INSERT INTO tickets (from_email, organization, subject, email_date, message_uid, status)
                                 VALUES (?, ?, ?, ?, ?, 'open')`,
                                [from, org, subject, emailDate, uid.toString()],
                                function(err) {
                                    if (!err && this.lastID) {
                                        ticketId = this.lastID;
                                        db.run(
                                            `INSERT INTO ticket_messages (ticket_id, from_email, body_text, created_at, is_internal, message_uid)
                                             VALUES (?, ?, ?, datetime('now', 'utc'), 0, ?)`,
                                            [ticketId, from, bodyText, uid.toString()]
                                        );
                                    }
                                    resolve();
                                }
                            );
                        });
                    }

                    // Сохраняем исходное письмо в таблицу feedback
                    await new Promise((resolve, reject) => {
                        db.run(
                            `INSERT OR IGNORE INTO feedback
                                (from_email, subject, body_text, email_date, message_uid)
                             VALUES (?, ?, ?, ?, ?)`,
                            [from, subject, bodyText, emailDate, uid.toString()],
                            function (err) {
                                if (err) reject(err);
                                else {
                                    if (this.changes > 0) saved++;
                                    else duplicates++;
                                    resolve();
                                }
                            }
                        );
                    });

                    if (batchProcessed >= BATCH_SIZE) {
                        console.log(`⏸️ Обработано ${BATCH_SIZE} писем, переподключаемся...`);
                        break;
                    }
                }

                const uidStart = firstUid || (lastUid + 1);
                const uidEnd = maxUid;
                const covered = uidEnd - lastUid;
                const skipped = covered - batchProcessed;
                console.log(`📊 Статистика: проверено UID с ${uidStart} по ${uidEnd} (охвачено ${covered} UID), из них новых ${saved}, дубликатов/пропущено ${skipped}`);

                if (maxUid > lastUid) {
                    await setLastUid(maxUid);
                    console.log(`💾 Прогресс сохранён: last_uid = ${maxUid}`);
                } else {
                    console.log(`🔄 Новых писем нет.`);
                    break;
                }

                console.log(`📦 Пачка завершена: обработано ${batchProcessed}, сохранено новых ${saved}, дубликатов ${duplicates}`);

                if (connected) {
                    try {
                        await client.logout();
                    } catch (logoutErr) {
                        if (!logoutErr.message?.includes('Connection not available')) {
                            console.warn('⚠️ Ошибка при logout:', logoutErr.message);
                        }
                    }
                }

                if (totalProcessedThisSession >= PAUSE_AFTER) {
                    shouldLongPause = true;
                    break;
                }

                await new Promise(resolve => setTimeout(resolve, 2000));

            } catch (err) {
                console.error('❌ Ошибка при обработке пачки:', err.message);
                if (maxUid > lastUid) {
                    try {
                        await setLastUid(maxUid);
                        console.log(`💾 Прогресс сохранён после ошибки: last_uid = ${maxUid}`);
                    } catch (dbErr) {
                        console.error('Не удалось сохранить прогресс:', dbErr.message);
                    }
                }
                if (connected) {
                    try { await client.logout(); } catch (_) {}
                }
                console.log(`⏱️ Ожидание 2 минуты перед повторной попыткой...`);
                await new Promise(resolve => setTimeout(resolve, 2 * 60 * 1000));
                continue;
            }
        }

        if (shouldLongPause) {
            console.log(`⏸️ Обработано ${totalProcessedThisSession} писем. Делаем паузу ${LONG_PAUSE_MINUTES} минут...`);
            await new Promise(resolve => setTimeout(resolve, LONG_PAUSE_MINUTES * 60 * 1000));
            console.log('⏰ Пауза завершена, можно продолжать.');
        }

        console.log(`🏁 Глобальная проверка завершена.`);

    } catch (globalErr) {
        console.error('💥 Критическая ошибка в fetchNewEmails:', globalErr.message);
    } finally {
        isFetching = false;
    }
}

// ========== ЗАПУСК ПРОВЕРКИ ==========
const CHECK_INTERVAL_MINUTES = 20;
setInterval(() => {
    fetchNewEmails().catch(e => console.error('Ошибка в setInterval:', e));
}, CHECK_INTERVAL_MINUTES * 60 * 1000);

setTimeout(() => fetchNewEmails().catch(e => console.error('Ошибка при первом запуске:', e)), 3000);

// ========== EXPRESS НАСТРОЙКИ ==========
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
    store: new SQLiteStore({
        db: 'database.db',
        table: 'sessions',
        concurrentDB: true
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 1000 * 60 * 60 * 24
    }
}));

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Flash-сообщения (простой вариант через сессию)
app.use((req, res, next) => {
  res.flash = (type, message) => {
    if (!req.session.flash) req.session.flash = [];
    req.session.flash.push({ type, message });
  };
  next();
});

// middleware для передачи flash в шаблоны
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || [];
  req.session.flash = [];
  next();
});

const csrfProtection = csrf();
app.use('/admin', csrfProtection);

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Слишком много попыток входа. Попробуйте позже.',
    standardHeaders: true,
    legacyHeaders: false,
});

const requireAdmin = (req, res, next) => {
    if (req.session.isAdmin) next();
    else res.redirect('/admin/login');
};

// ========== МАРШРУТЫ ==========
app.get('/', (req, res) => res.render('index'));

app.get('/admin/login', (req, res) => {
    if (req.session.isAdmin) return res.redirect('/admin');
    const error = req.session.loginError || null;
    req.session.loginError = null;
    res.render('admin-login', { error, csrfToken: req.csrfToken() });
});

app.post('/admin/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        req.session.loginError = 'Введите логин и пароль.';
        return res.redirect('/admin/login');
    }

    db.get(`SELECT password_hash FROM users WHERE username = ?`, [username], async (err, row) => {
        if (err) {
            console.error(err);
            req.session.loginError = 'Ошибка сервера.';
            return res.redirect('/admin/login');
        }
        if (!row) {
            req.session.loginError = 'Неверный логин или пароль.';
            return res.redirect('/admin/login');
        }

        try {
            const match = await bcrypt.compare(password, row.password_hash);
            if (match) {
                req.session.isAdmin = true;
                res.redirect('/admin');
            } else {
                req.session.loginError = 'Неверный логин или пароль.';
                res.redirect('/admin/login');
            }
        } catch (e) {
            console.error(e);
            req.session.loginError = 'Ошибка проверки пароля.';
            res.redirect('/admin/login');
        }
    });
});

app.post('/admin/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/admin/login'));
});

app.get('/admin', requireAdmin, (req, res) => {
    const { uid_from, uid_to, date_from, date_to, search, tab, sub, period } = req.query;

    const sort = req.query.sort || 'id';
    const order = req.query.order || 'desc';

    let sql = `SELECT f.id, f.from_email, f.subject, f.body_text, f.email_date, f.received_at, f.message_uid,
                      t.id as ticket_id, t.status as ticket_status, t.last_reply_at,
                      u.display_name as closed_by_display, t.closed_by
               FROM feedback f
               LEFT JOIN tickets t ON f.message_uid = t.message_uid
               LEFT JOIN users u ON t.closed_by = u.username`;

    const params = [];
    const conditions = [];

    // Старые фильтры
    if (uid_from && !isNaN(uid_from)) { conditions.push(`f.id >= ?`); params.push(parseInt(uid_from)); }
    if (uid_to && !isNaN(uid_to))   { conditions.push(`f.id <= ?`); params.push(parseInt(uid_to)); }
    if (date_from) { conditions.push(`DATE(f.email_date) >= DATE(?)`); params.push(date_from); }
    if (date_to)   { conditions.push(`DATE(f.email_date) <= DATE(?)`); params.push(date_to); }
    if (search && search.trim()) {
        conditions.push(`(LOWER(t.from_email) LIKE LOWER(?) OR LOWER(t.organization) LIKE LOWER(?) OR LOWER(t.subject) LIKE LOWER(?))`);
        const pattern = `%${search.trim()}%`;
        params.push(pattern, pattern, pattern);
    }

    // Вкладка и подкатегория
    if (tab === 'open') {
        if (sub === 'waiting') {
            conditions.push(`t.status = 'waiting'`);
        } else {
            conditions.push(`t.status = 'open'`);
        }
    } else if (tab === 'closed') {
        conditions.push(`t.status = 'closed'`);
        let dateCondition = '';
        if (period === 'today')       dateCondition = "DATE(t.last_reply_at) = DATE('now')";
        else if (period === 'week')   dateCondition = "t.last_reply_at >= datetime('now', '-7 days')";
        else if (period === 'month')  dateCondition = "t.last_reply_at >= datetime('now', '-1 month')";
        else if (period === 'half_year') dateCondition = "t.last_reply_at >= datetime('now', '-6 months')";
        else if (period === 'year')   dateCondition = "t.last_reply_at >= datetime('now', '-1 year')";
        if (dateCondition) conditions.push(dateCondition);
    }

    if (conditions.length > 0) {
        sql += ` WHERE ` + conditions.join(' AND ');
    }

    // Сортировка
    const allowedColumns = ['id', 'from_email', 'subject', 'email_date', 'ticket_status', 'last_reply_at'];
    const sortColumn = allowedColumns.includes(sort) ? sort : 'id';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

    switch (sortColumn) {
        case 'id': sql += ` ORDER BY f.id ${sortOrder}`; break;
        case 'from_email': sql += ` ORDER BY f.from_email ${sortOrder}`; break;
        case 'subject': sql += ` ORDER BY f.subject ${sortOrder}`; break;
        case 'email_date': sql += ` ORDER BY f.email_date ${sortOrder}`; break;
        case 'ticket_status': sql += ` ORDER BY t.status ${sortOrder}`; break;
        case 'last_reply_at': sql += ` ORDER BY t.last_reply_at ${sortOrder}`; break;
        default: sql += ` ORDER BY f.email_date DESC`;
    }

    db.all(sql, params, (err, rows) => {
        if (err) {
            console.error('Ошибка получения сообщений:', err.message);
            return res.status(500).send('Ошибка сервера');
        }
        res.render('admin', {
            messages: rows,
            filters: { uid_from, uid_to, date_from, date_to, search, tab, sub, period, sort, order },
            csrfToken: req.csrfToken()
        });
    });
});

app.post('/admin/toggle-read/:id', requireAdmin, (req, res) => {
    const id = req.params.id;
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Неверный ID' });

    db.get(`SELECT is_read FROM feedback WHERE id = ?`, [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Сообщение не найдено' });

        const newStatus = row.is_read ? 0 : 1;
        db.run(`UPDATE feedback SET is_read = ? WHERE id = ?`, [newStatus, id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, is_read: newStatus });
        });
    });
});

// ========== НОВЫЕ МАРШРУТЫ ЗАЯВОК ==========

// Список заявок с категориями
app.get('/admin/tickets', requireAdmin, (req, res) => {
    const { search, tab, sub, period, sort, order,
            ticket_id, email, organization, date_from, date_to, closed_by, assigned_to } = req.query;

    let sql = `SELECT t.*,
                      u1.display_name as closed_by_display,
                      u2.display_name as assigned_to_display
               FROM tickets t 
               LEFT JOIN users u1 ON t.closed_by = u1.username 
               LEFT JOIN users u2 ON t.assigned_to = u2.username 
               WHERE 1=1`;
    const params = [];
    const conditions = [];

    // Фильтр по ID заявки
    if (ticket_id && !isNaN(ticket_id)) {
        conditions.push(`t.id = ?`);
        params.push(parseInt(ticket_id));
    }
    // Фильтр по email отправителя
    if (email && email.trim()) {
        conditions.push(`LOWER(t.from_email) LIKE LOWER(?)`);
        params.push(`%${email.trim()}%`);
    }
    // Фильтр по организации (новый)
    if (organization && organization.trim()) {
        conditions.push(`LOWER(t.organization) LIKE LOWER(?)`);
        params.push(`%${organization.trim()}%`);
    }
    // Фильтр по дате создания
    if (date_from) {
        conditions.push(`DATE(t.email_date) >= DATE(?)`);
        params.push(date_from);
    }
    if (date_to) {
        conditions.push(`DATE(t.email_date) <= DATE(?)`);
        params.push(date_to);
    }
    // Фильтр по "кем закрыто"
    if (closed_by && closed_by.trim()) {
        conditions.push(`LOWER(u1.display_name) LIKE LOWER(?)`);
        params.push(`%${closed_by.trim()}%`);
    }
    // Фильтр по "назначен"
    if (assigned_to && assigned_to.trim()) {
        conditions.push(`t.assigned_to = ?`);
        params.push(assigned_to.trim());
    }
    // Поиск по email, организации, теме
    if (search && search.trim()) {
        conditions.push(`(t.from_email LIKE ? OR t.organization LIKE ? OR t.subject LIKE ?)`);
        const pattern = `%${search.trim()}%`;
        params.push(pattern, pattern, pattern);
    }

    // Вкладки (статус)
    if (tab === 'open') {
        conditions.push(`t.status != 'closed'`);
        if (sub === 'waiting') conditions.push(`t.status = 'waiting'`);
        else if (sub === 'open') conditions.push(`t.status = 'open'`);
    } else if (tab === 'closed') {
        conditions.push(`t.status = 'closed'`);
        let dateCondition = '';
        if (period === 'today') dateCondition = "DATE(t.last_reply_at) = DATE('now')";
        else if (period === 'week') dateCondition = "t.last_reply_at >= datetime('now', '-7 days')";
        else if (period === 'month') dateCondition = "t.last_reply_at >= datetime('now', '-1 month')";
        else if (period === 'half_year') dateCondition = "t.last_reply_at >= datetime('now', '-6 months')";
        else if (period === 'year') dateCondition = "t.last_reply_at >= datetime('now', '-1 year')";
        if (dateCondition) conditions.push(dateCondition);
    }

    if (conditions.length) sql += ' AND ' + conditions.join(' AND ');

    // Сортировка
    const allowedColumns = ['t.id', 't.organization', 't.from_email', 't.subject', 't.email_date', 't.status', 't.last_reply_at'];
    const sortColumn = allowedColumns.includes(sort) ? sort : 't.id';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY ${sortColumn} ${sortOrder}`;

    db.all(sql, params, (err, tickets) => {
        if (err) return res.status(500).send('Ошибка');
        // Получаем список пользователей для фильтров
        db.all(`SELECT username, display_name FROM users ORDER BY display_name`, (err, users) => {
            if (err) users = [];
            res.render('tickets', {
                tickets,
                users,
                filters: { search, tab, sub, period, sort, order,
                    ticket_id, email, organization, date_from, date_to, closed_by, assigned_to },
                csrfToken: req.csrfToken()
            });
        });
    });
});

app.get('/admin/tickets/create', requireAdmin, (req, res) => {
    res.render('create-ticket', { csrfToken: req.csrfToken() });
});

// Страница создания заявки (вручную)
app.post('/admin/tickets/create', requireAdmin, (req, res) => {
    const { organization, from_email, subject, body } = req.body;
    if (!subject || !body) return res.redirect('/admin/tickets/create');

    let finalOrg = organization || '';
    const nowUTC5 = moment().utcOffset(300).format('YYYY-MM-DDTHH:mm:ss+05:00');

    // Если email введён, а организация пуста – пытаемся подставить из предыдущих заявок
    if (from_email && !organization) {
        db.get(
            `SELECT organization FROM tickets WHERE from_email = ? AND organization IS NOT NULL ORDER BY id DESC LIMIT 1`,
            [from_email],
            (err, row) => {
                if (row) finalOrg = row.organization;
                createTicket(finalOrg);
            }
        );
    } else {
        createTicket(finalOrg);
    }

    function createTicket(org) {
        db.get(
            `SELECT MAX(CAST(replace(message_uid, 'manual-', '') AS INTEGER)) AS maxManual FROM tickets WHERE message_uid LIKE 'manual-%'`,
            (err, row) => {
                const lastManual = row?.maxManual || 0;
                const newManualUid = 'manual-' + (lastManual + 1);

                db.run(
                    `INSERT INTO tickets (organization, from_email, subject, email_date, status, category, message_uid)
                     VALUES (?, ?, ?, ?, 'open', 'manual', ?)`,
                    [org, from_email || null, subject, nowUTC5, newManualUid],
                    function (err) {
                        if (err) {
                            console.error('Ошибка при создании заявки:', err.message);
                            return res.status(500).send('Ошибка создания заявки');
                        }
                        const ticketId = this.lastID;
                        if (!ticketId) {
                            console.error('Не удалось получить ID заявки');
                            return res.status(500).send('Ошибка создания заявки');
                        }

                        // Пишем в feedback
                        db.run(
                            `INSERT INTO feedback (from_email, subject, body_text, email_date, message_uid)
                             VALUES (?, ?, ?, ?, ?)`,
                            [from_email || 'no-email', subject, body, nowUTC5, newManualUid]
                        );

                        // Сообщение в чат
                        db.run(
                            `INSERT INTO ticket_messages (ticket_id, from_email, body_text, created_at, is_internal)
                             VALUES (?, ?, 'Заявка создана вручную', ?, 1)`,
                            [ticketId, from_email || 'system', nowUTC5]
                        );

                        res.redirect('/admin/tickets/' + ticketId);
                    }
                );
            }
        );
    }
});

// Страница тикета (чат)
app.get('/admin/tickets/:id', requireAdmin, (req, res) => {
    const id = req.params.id;
    db.get(`SELECT t.*,
                   u1.display_name as closed_by_display,
                   u2.display_name as assigned_to_display
            FROM tickets t 
            LEFT JOIN users u1 ON t.closed_by = u1.username 
            LEFT JOIN users u2 ON t.assigned_to = u2.username 
            WHERE t.id = ?`, [id], (err, ticket) => {
        if (err || !ticket) return res.status(404).send('Тикет не найден');
        db.all(`SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC`, [id], (err, messages) => {
            if (err) return res.status(500).send('Ошибка');

            db.get(`SELECT body_text FROM ticket_messages 
                    WHERE ticket_id = ? AND is_internal = 1 AND body_text LIKE '%|%'
                    ORDER BY created_at DESC LIMIT 1`, [id], (err, noteRow) => {
                const lastNote = noteRow ? noteRow.body_text.split('|')[1] : null;

                db.all(`SELECT username, display_name FROM users ORDER BY username`, (err, agents) => {
                    if (err) agents = [];
                    res.render('ticket', {
                        ticket,
                        messages,
                        agents,
                        lastNote,
                        csrfToken: req.csrfToken()
                    });
                });
            });
        });
    });
});

// Отправка ответа
app.post('/admin/tickets/:id/reply', requireAdmin, async (req, res) => {
    const id = req.params.id;
    const { body, status, signature } = req.body;
    if (!body) {
        res.flash('error', 'Текст ответа не может быть пустым.');
        return res.redirect('/admin/tickets/' + id);
    }

    try {
        const ticket = await new Promise((resolve, reject) => {
            db.get(`SELECT * FROM tickets WHERE id = ?`, [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!ticket) {
            res.flash('error', 'Заявка не найдена.');
            return res.redirect('/admin/tickets');
        }

        const agentEmail = process.env.IMAP_USER;
        const fullBody = (signature ? signature + '\n\n' : '') + body;

        // Пытаемся отправить письмо, только если у заявки есть email
        let emailSent = false;
        let emailError = null;

        if (ticket.from_email) {
            try {
                const isManualTicket = ticket.message_uid && ticket.message_uid.startsWith('manual-');
                const subject = isManualTicket
                    ? `[Ticket #${ticket.id}] ${ticket.subject}`
                    : `Re: ${ticket.subject}`;
                await sendEmail(ticket.from_email, subject, fullBody, ticket.message_uid, ticket.message_uid);
                emailSent = true;
                console.log(`✅ Ответ отправлен на ${ticket.from_email}`);
            } catch (e) {
                emailError = e.message;
                console.error('❌ Ошибка отправки письма:', e.message);
            }
        }

        // Записываем сообщение агента (всегда)
        const nowUTC = moment().utcOffset(300).format('YYYY-MM-DDTHH:mm:ss+05:00');
        await new Promise((resolve, reject) => {
            db.run(`INSERT INTO ticket_messages (ticket_id, from_email, body_text, created_at, is_internal) VALUES (?, ?, ?, ?, 1)`,
                [id, agentEmail, fullBody, nowUTC], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
        });

        // Записываем системное сообщение о результате отправки
        let sysMessage;
        if (emailSent) {
            sysMessage = `✅ Письмо успешно отправлено клиенту на ${ticket.from_email}.`;
            res.flash('success', 'Ответ отправлен и письмо доставлено.');
        } else if (ticket.from_email && emailError) {
            sysMessage = `❌ Ошибка отправки письма: ${emailError}. Пожалуйста, попробуйте снова или проверьте почтовый сервер.`;
            res.flash('error', 'Ответ записан, но письмо не отправлено из-за ошибки.');
        } else if (!ticket.from_email) {
            sysMessage = `ℹ️ У заявки нет email, письмо не отправлялось.`;
            res.flash('info', 'Ответ сохранён (email не указан).');
        } else {
            sysMessage = `⚠️ Отправка не выполнялась.`;
            res.flash('warning', 'Статус отправки не определён.');
        }

        await new Promise((resolve, reject) => {
            db.run(`INSERT INTO ticket_messages (ticket_id, from_email, body_text, created_at, is_internal) VALUES (?, ?, ?, ?, 1)`,
                [id, 'system', sysMessage, nowUTC], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
        });

        // Обновляем время последнего ответа и опционально статус
        await new Promise((resolve, reject) => {
            db.run(`UPDATE tickets SET last_reply_at = ?, last_reply_from = ? WHERE id = ?`,
                [nowUTC, agentEmail, id], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
        });

        if (status) {
            await new Promise((resolve, reject) => {
                db.run(`UPDATE tickets SET status = ? WHERE id = ?`,
                    [status, id], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
            });
        }

    } catch (err) {
        console.error('Ошибка при обработке ответа:', err);
        res.flash('error', 'Внутренняя ошибка сервера.');
    }

    res.redirect('/admin/tickets/' + id);
});

// Смена статуса тикета
app.post('/admin/tickets/:id/status', requireAdmin, (req, res) => {
    const { status, closed_by, note } = req.body;
    const id = req.params.id;
    const nowUTC5 = moment().utcOffset(300).format('YYYY-MM-DDTHH:mm:ss+05:00');

    if (status === 'closed' && !closed_by) {
        return res.redirect('/admin/tickets/' + id);
    }

    const updateStatus = (closedByName) => {
        db.run(`UPDATE tickets SET status = ?, 
                last_reply_at = CASE WHEN ? = 'closed' THEN ? ELSE last_reply_at END,
                closed_by = CASE WHEN ? = 'closed' THEN ? ELSE closed_by END
                WHERE id = ?`,
            [status, status, nowUTC5, status, closed_by, id]);

        let message;
        if (status === 'closed') {
            message = `Закрыта пользователем ${closedByName || closed_by}.`;
        } else {
            const statusNames = { open: 'Открыта', waiting: 'В ожидании' };
            const statusName = statusNames[status] || status;
            message = `Статус изменён на «${statusName}»`;
        }

        if (note && note.trim()) {
            message += `|Заметка: ${note.trim()}`;
        }

        db.run(`INSERT INTO ticket_messages (ticket_id, from_email, body_text, is_internal) VALUES (?, ?, ?, 1)`,
            [id, process.env.IMAP_USER, message]);

        res.redirect('/admin/tickets/' + id);
    };

    if (status === 'closed') {
        db.get(`SELECT display_name FROM users WHERE username = ?`, [closed_by], (err, row) => {
            const name = (row && row.display_name) ? row.display_name : closed_by;
            updateStatus(name);
        });
    } else {
        updateStatus('');
    }
});

app.post('/admin/tickets/:id/assign', requireAdmin, (req, res) => {
    const id = req.params.id;
    const { assigned_to, note } = req.body;

    const finalize = (displayName) => {
        db.run(`UPDATE tickets SET assigned_to = ? WHERE id = ?`, [assigned_to || null, id]);
        const message = `Назначен: ${displayName}` + (note ? `|Заметка: ${note}` : '');
        db.run(`INSERT INTO ticket_messages (ticket_id, from_email, body_text, is_internal) VALUES (?, ?, ?, 1)`,
            [id, process.env.IMAP_USER, message]);
        res.redirect('/admin/tickets/' + id);
    };

    if (assigned_to) {
        db.get(`SELECT display_name FROM users WHERE username = ?`, [assigned_to], (err, row) => {
            const name = (row && row.display_name) ? row.display_name : assigned_to;
            finalize(name);
        });
    } else {
        finalize('никто');
    }
});

app.post('/admin/tickets/:id/edit', requireAdmin, (req, res) => {
    const id = req.params.id;
    const { organization, from_email } = req.body;

    // Сначала обновляем сам тикет
    db.run(`UPDATE tickets SET organization = ?, from_email = ? WHERE id = ?`,
        [organization || null, from_email || null, id],
        function(err) {
            if (err) {
                console.error('Ошибка обновления заявки:', err.message);
                return res.status(500).send('Ошибка сервера');
            }

            // Если в форме был указан email (не пустой), синхронизируем организацию
            if (from_email && from_email.trim()) {
                // Обновляем организацию у всех заявок с таким же email
                db.run(`UPDATE tickets SET organization = ? WHERE from_email = ?`,
                    [organization || null, from_email.trim()]);
            }

            // Добавляем заметку в чат
            const changes = [];
            if (organization !== undefined) changes.push(`Организация изменена на «${organization || '—'}»`);
            if (from_email !== undefined) changes.push(`Email изменён на «${from_email || '—'}»`);
            if (changes.length > 0) {
                db.run(`INSERT INTO ticket_messages (ticket_id, from_email, body_text, is_internal) VALUES (?, ?, ?, 1)`,
                    [id, process.env.IMAP_USER, changes.join('. ')]);
            }

            res.redirect('/admin/tickets/' + id);
        });
});

app.post('/admin/tickets/bulk', requireAdmin, (req, res) => {
    let { ids, action, assigned_to, closed_by } = req.body;

    if (!ids) {
        res.flash('error', 'Не выбрано ни одной заявки.');
        return res.redirect('/admin/tickets');
    }

    if (!Array.isArray(ids)) {
        ids = [ids];
    }

    if (ids.length === 0) {
        res.flash('error', 'Не выбрано ни одной заявки.');
        return res.redirect('/admin/tickets');
    }

    const now = moment().utcOffset(300).format('YYYY-MM-DDTHH:mm:ss+05:00');
    const agentEmail = process.env.IMAP_USER;

    const placeholders = ids.map(() => '?').join(',');

    if (action === 'assign') {
        if (!assigned_to) {
            res.flash('error', 'Не указан агент для назначения.');
            return res.redirect('/admin/tickets');
        }
        // Получаем отображаемое имя агента
        db.get(`SELECT display_name FROM users WHERE username = ?`, [assigned_to], (err, row) => {
            const display = (row && row.display_name) ? row.display_name : assigned_to;

            db.run(`UPDATE tickets SET assigned_to = ? WHERE id IN (${placeholders})`,
                [assigned_to, ...ids],
                function(err) {
                    if (err) {
                        console.error('Ошибка массового назначения:', err);
                        res.flash('error', 'Ошибка при назначении.');
                        return res.redirect('/admin/tickets');
                    }
                    // Добавим сообщение в каждый тикет
                    ids.forEach(id => {
                        db.run(`INSERT INTO ticket_messages (ticket_id, from_email, body_text, created_at, is_internal)
                                VALUES (?, ?, ?, ?, 1)`,
                            [id, agentEmail, `Назначен: ${display}`, now]);
                    });
                    res.flash('success', `Назначено заявок: ${ids.length}`);
                    res.redirect('/admin/tickets');
                });
        });
    } else if (action === 'close') {
        if (!closed_by) {
            res.flash('error', 'Не указано, кем закрыто.');
            return res.redirect('/admin/tickets');
        }
        db.get(`SELECT display_name FROM users WHERE username = ?`, [closed_by], (err, row) => {
            const display = (row && row.display_name) ? row.display_name : closed_by;
            db.run(`UPDATE tickets SET status = 'closed', closed_by = ?, last_reply_at = ? WHERE id IN (${placeholders}) AND status != 'closed'`,
                [closed_by, now, ...ids],
                function(err) {
                    if (err) {
                        console.error('Ошибка массового закрытия:', err);
                        res.flash('error', 'Ошибка при закрытии.');
                        return res.redirect('/admin/tickets');
                    }
                    ids.forEach(id => {
                        db.run(`INSERT INTO ticket_messages (ticket_id, from_email, body_text, created_at, is_internal)
                                VALUES (?, ?, ?, ?, 1)`,
                            [id, agentEmail, `Закрыта пользователем ${display}`, now]);
                    });
                    res.flash('success', `Закрыто заявок: ${this.changes}`);
                    res.redirect('/admin/tickets');
                });
        });
    } else if (action === 'open') {
        db.run(`UPDATE tickets SET status = 'open', closed_by = NULL WHERE id IN (${placeholders}) AND status = 'closed'`,
            [...ids],
            function(err) {
                if (err) {
                    console.error('Ошибка массового открытия:', err);
                    res.flash('error', 'Ошибка при открытии.');
                    return res.redirect('/admin/tickets');
                }
                ids.forEach(id => {
                    db.run(`INSERT INTO ticket_messages (ticket_id, from_email, body_text, created_at, is_internal)
                            VALUES (?, ?, ?, ?, 1)`,
                        [id, agentEmail, `Заявка вновь открыта`, now]);
                });
                res.flash('success', `Открыто заявок: ${this.changes}`);
                res.redirect('/admin/tickets');
            });
    } else {
        res.flash('error', 'Неизвестное действие.');
        res.redirect('/admin/tickets');
    }
});

app.use((err, req, res, next) => {
    if (err.code === 'EBADCSRFTOKEN') {
        return res.status(403).send('Недействительный CSRF-токен');
    }
    next(err);
});

app.listen(PORT, () => console.log(`Сервер запущен на http://localhost:${PORT}`));