// view-data.js - просмотр данных базы данных

// # Справка help
// node view-data.js help 

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
    if (err) {
        console.error('❌ Не удалось открыть базу данных:', err.message);
        process.exit(1);
    }
});

const args = process.argv.slice(2);
const command = args[0] || 'stats';

function printTable(columns, rows) {
    if (rows.length === 0) {
        console.log('Нет данных для отображения.');
        return;
    }

    const widths = columns.map(col => col.length);
    for (const row of rows) {
        for (let i = 0; i < columns.length; i++) {
            const val = String(row[columns[i]] ?? '');
            widths[i] = Math.max(widths[i], val.length);
        }
    }

    const separator = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
    
    console.log(separator);
    const header = '| ' + columns.map((col, i) => col.padEnd(widths[i])).join(' | ') + ' |';
    console.log(header);
    console.log(separator);

    for (const row of rows) {
        const line = '| ' + columns.map((col, i) => {
            const val = String(row[col] ?? '');
            return val.padEnd(widths[i]);
        }).join(' | ') + ' |';
        console.log(line);
    }
    console.log(separator);
}

// ========== СТАТИСТИКА ==========
function showStats() {
    db.serialize(() => {
        console.log(`\n📊 СТАТИСТИКА БАЗЫ ДАННЫХ`);
        console.log(`─────────────────────────`);

        db.get(`SELECT COUNT(*) as total FROM feedback`, (err, row) => {
            if (!err) console.log(`Всего писем (feedback): ${row.total}`);
        });

        db.get(`SELECT COUNT(*) as total FROM tickets`, (err, row) => {
            if (!err) console.log(`Всего заявок (tickets): ${row.total}`);
        });

        db.get(`SELECT COUNT(*) as total FROM tickets WHERE status = 'open'`, (err, row) => {
            if (!err) console.log(`  - Открытых: ${row.total}`);
        });

        db.get(`SELECT COUNT(*) as total FROM tickets WHERE status = 'waiting'`, (err, row) => {
            if (!err) console.log(`  - В ожидании: ${row.total}`);
        });

        db.get(`SELECT COUNT(*) as total FROM tickets WHERE status = 'closed'`, (err, row) => {
            if (!err) console.log(`  - Закрытых: ${row.total}`);
        });

        db.get(`SELECT COUNT(*) as total FROM ticket_messages`, (err, row) => {
            if (!err) console.log(`Всего сообщений в чатах: ${row.total}`);
        });

        db.get(`SELECT COUNT(*) as admins FROM users`, (err, row) => {
            if (!err) console.log(`Администраторов: ${row.admins}`);
        });

        db.get(`SELECT MAX(id) as last_id FROM feedback`, (err, row) => {
            if (!err) console.log(`Последний ID сообщения: ${row.last_id || '—'}`);
        });

        db.get(`SELECT MAX(id) as last_ticket FROM tickets`, (err, row) => {
            if (!err) console.log(`Последний ID заявки: ${row.last_ticket || '—'}`);
        });

        db.get(`SELECT value FROM sync_state WHERE key = 'last_uid'`, (err, row) => {
            if (!err) console.log(`Последний обработанный UID (почта): ${row?.value || '0'}`);
        });

        db.get(`SELECT COUNT(*) as sessions FROM sessions`, (err, row) => {
            if (!err) console.log(`Активных сессий: ${row?.sessions || 0}`);
        });

        db.close();
    });
}

// ========== ПОСЛЕДНИЕ СООБЩЕНИЯ (feedback) ==========
function showMessages(limit = 10) {
    const sql = `SELECT f.id, f.from_email, f.subject, 
                 substr(f.body_text, 1, 50) as preview,
                 f.email_date, f.message_uid,
                 t.id as ticket_id, t.status
                 FROM feedback f
                 LEFT JOIN tickets t ON f.message_uid = t.message_uid
                 ORDER BY f.id DESC LIMIT ?`;
    db.all(sql, [limit], (err, rows) => {
        if (err) {
            console.error('Ошибка:', err.message);
            db.close();
            return;
        }
        console.log(`\n📬 ПОСЛЕДНИЕ ${limit} СООБЩЕНИЙ (feedback)`);
        printTable(['id', 'from_email', 'subject', 'preview', 'email_date', 'ticket_id', 'status'], rows);
        db.close();
    });
}

// ========== ПОСЛЕДНИЕ ЗАЯВКИ (tickets) ==========
function showTickets(limit = 10) {
    const sql = `SELECT t.id, t.organization, t.from_email, t.subject, 
                 t.email_date, t.status, t.assigned_to, t.closed_by,
                 u1.display_name as assigned_display,
                 u2.display_name as closed_display,
                 (SELECT COUNT(*) FROM ticket_messages WHERE ticket_id = t.id) as msg_count
                 FROM tickets t
                 LEFT JOIN users u1 ON t.assigned_to = u1.username
                 LEFT JOIN users u2 ON t.closed_by = u2.username
                 ORDER BY t.id DESC LIMIT ?`;
    db.all(sql, [limit], (err, rows) => {
        if (err) {
            console.error('Ошибка:', err.message);
            db.close();
            return;
        }
        console.log(`\n🎫 ПОСЛЕДНИЕ ${limit} ЗАЯВОК`);
        printTable(['id', 'organization', 'from_email', 'subject', 'email_date', 'status', 'assigned_to', 'closed_by', 'msg_count'], rows);
        db.close();
    });
}

// ========== ПРОСМОТР КОНКРЕТНОЙ ЗАЯВКИ (с сообщениями чата) ==========
function showTicket(ticketId) {
    db.get(`SELECT t.*, 
                   u1.display_name as assigned_display,
                   u2.display_name as closed_display
            FROM tickets t
            LEFT JOIN users u1 ON t.assigned_to = u1.username
            LEFT JOIN users u2 ON t.closed_by = u2.username
            WHERE t.id = ?`, [ticketId], (err, ticket) => {
        if (err || !ticket) {
            console.error('Заявка не найдена.');
            db.close();
            return;
        }
        console.log(`\n🎫 ЗАЯВКА #${ticket.id}`);
        console.log(`Тема: ${ticket.subject}`);
        console.log(`Организация: ${ticket.organization || '—'}`);
        console.log(`Email: ${ticket.from_email || '—'}`);
        console.log(`Статус: ${ticket.status}`);
        console.log(`Назначен: ${ticket.assigned_display || ticket.assigned_to || '—'}`);
        console.log(`Закрыл: ${ticket.closed_display || ticket.closed_by || '—'}`);
        console.log(`Создана: ${ticket.email_date}`);
        console.log(`Последний ответ: ${ticket.last_reply_at || '—'}`);
        console.log(`\n💬 СООБЩЕНИЯ ЧАТА:`);
        
        db.all(`SELECT id, from_email, body_text, created_at, is_internal 
                FROM ticket_messages 
                WHERE ticket_id = ? 
                ORDER BY created_at ASC`, [ticketId], (err, messages) => {
            if (err) {
                console.error('Ошибка загрузки сообщений:', err.message);
                db.close();
                return;
            }
            if (messages.length === 0) {
                console.log('(нет сообщений)');
            } else {
                messages.forEach(msg => {
                    const type = msg.is_internal ? '👤 Внутреннее' : '📧 От клиента';
                    console.log(`[${msg.created_at}] ${type} <${msg.from_email}>`);
                    console.log(`   ${msg.body_text}`);
                    console.log('---');
                });
            }
            db.close();
        });
    });
}

// ========== ПОИСК ПО ЗАЯВКАМ ==========
function searchTickets(query) {
    const sql = `SELECT t.id, t.organization, t.from_email, t.subject, 
                 substr(t.subject, 1, 60) as subj_preview,
                 t.email_date, t.status
                 FROM tickets t
                 WHERE t.subject LIKE ? OR t.organization LIKE ? OR t.from_email LIKE ?
                 ORDER BY t.id DESC LIMIT 20`;
    const pattern = `%${query}%`;
    db.all(sql, [pattern, pattern, pattern], (err, rows) => {
        if (err) {
            console.error('Ошибка:', err.message);
            db.close();
            return;
        }
        console.log(`\n🔍 РЕЗУЛЬТАТЫ ПОИСКА ПО ЗАЯВКАМ: "${query}"`);
        printTable(['id', 'organization', 'from_email', 'subject', 'email_date', 'status'], rows);
        db.close();
    });
}

// ========== СПИСОК АДМИНИСТРАТОРОВ ==========
function showAdmins() {
    db.all(`SELECT id, username, display_name FROM users ORDER BY username`, (err, rows) => {
        if (err) {
            console.error('Ошибка:', err.message);
            db.close();
            return;
        }
        console.log(`\n👥 АДМИНИСТРАТОРЫ`);
        printTable(['id', 'username', 'display_name'], rows);
        db.close();
    });
}

// ========== СПРАВКА ==========
function showHelp() {
    console.log(`
📘 ИСПОЛЬЗОВАНИЕ: node view-data.js [команда] [параметры]

Команды:
  stats                    Показать статистику базы данных (по умолчанию)
  messages [N]             Показать последние N писем (feedback) (по умолчанию 10)
  tickets [N]              Показать последние N заявок (по умолчанию 10)
  ticket <id>              Показать заявку с сообщениями чата
  admins                   Показать список администраторов
  search "текст"           Найти заявки по тексту (тема, организация, email)
  help                     Показать эту справку

Примеры:
  node view-data.js
  node view-data.js stats
  node view-data.js messages 20
  node view-data.js tickets 5
  node view-data.js ticket 42
  node view-data.js search "важное письмо"
  node view-data.js admins
`);
    db.close();
}

// ========== ОБРАБОТКА КОМАНД ==========
switch (command) {
    case 'stats':
        showStats();
        break;
    case 'messages':
        const msgLimit = parseInt(args[1]) || 10;
        showMessages(msgLimit);
        break;
    case 'tickets':
        const ticketLimit = parseInt(args[1]) || 10;
        showTickets(ticketLimit);
        break;
    case 'ticket':
        const ticketId = parseInt(args[1]);
        if (!ticketId) {
            console.error('❌ Укажите ID заявки (число).');
            db.close();
            process.exit(1);
        }
        showTicket(ticketId);
        break;
    case 'admins':
        showAdmins();
        break;
    case 'search':
        const query = args[1];
        if (!query) {
            console.error('❌ Укажите текст для поиска.');
            db.close();
            process.exit(1);
        }
        searchTickets(query);
        break;
    case 'help':
    case '--help':
    case '-h':
        showHelp();
        break;
    default:
        console.error(`❌ Неизвестная команда: ${command}`);
        showHelp();
        db.close();
        process.exit(1);
}