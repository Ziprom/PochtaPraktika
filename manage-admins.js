// manage-admins.js - управление администраторами из командной строки

// # Добавить администратора
// node manage-admins add <username> <display_name>
// display_name можно в кавычках, например "Иван Петров"

// # Удалить администратора
// node manage-admins remove <username>

// # Изменить отображаемое имя
// node manage-admins update <username> <new_display_name>

// # Показать всех администраторов
// node manage-admins list

require('child_process').execSync('chcp 65001', { stdio: 'ignore' });

const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const readline = require('readline-sync');
const path = require('path');

const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath);

const command = process.argv[2];
const username = process.argv[3];
const displayName = process.argv[4];

if (!command) {
    console.log(`
Использование:
  node manage-admins add <username> <display_name>   – добавить администратора
  node manage-admins remove <username>               – удалить администратора
  node manage-admins update <username> <new_display> – изменить имя
  node manage-admins list                            – показать всех
`);
    process.exit(0);
}

db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT
)`);

if (command === 'add') {
    if (!username) {
        console.error('❌ Укажите имя пользователя.');
        process.exit(1);
    }
    const password = readline.question('Введите пароль (не отображается): ', { hideEchoBack: true });
    if (!password || password.length < 4) {
        console.error('❌ Пароль должен быть не менее 4 символов.');
        process.exit(1);
    }
    let name = displayName;
    if (!name) {
        name = readline.question('Введите отображаемое имя (Enter чтобы пропустить): ') || username;
    }
    (async () => {
        try {
            const hash = await bcrypt.hash(password, 10);
            db.run(`INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)`,
                [username, hash, name],
                function(err) {
                    if (err) {
                        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE')
                            console.error(`❌ Администратор "${username}" уже существует.`);
                        else
                            console.error('❌ Ошибка при добавлении:', err.message);
                    } else {
                        console.log(`✅ Администратор "${username}" добавлен (отображаемое имя: "${name}").`);
                    }
                    db.close();
                });
        } catch (e) {
            console.error('Ошибка хеширования пароля:', e);
            db.close();
        }
    })();
} else if (command === 'remove') {
    if (!username) {
        console.error('❌ Укажите имя пользователя для удаления.');
        process.exit(1);
    }
    if (username === 'admin') {
        console.error('❌ Нельзя удалить главного администратора "admin".');
        process.exit(1);
    }
    db.run(`DELETE FROM users WHERE username = ?`, [username], function(err) {
        if (err) {
            console.error('❌ Ошибка при удалении:', err.message);
        } else if (this.changes === 0) {
            console.error(`❌ Администратор "${username}" не найден.`);
        } else {
            console.log(`✅ Администратор "${username}" удалён.`);
        }
        db.close();
    });
} else if (command === 'update') {
    if (!username) {
        console.error('❌ Укажите имя пользователя для обновления.');
        process.exit(1);
    }
    let newName = displayName;
    if (!newName) {
        newName = readline.question('Введите новое отображаемое имя: ');
    }
    db.run(`UPDATE users SET display_name = ? WHERE username = ?`, [newName, username], function(err) {
        if (err) {
            console.error('❌ Ошибка при обновлении:', err.message);
        } else if (this.changes === 0) {
            console.error(`❌ Администратор "${username}" не найден.`);
        } else {
            console.log(`✅ Имя изменено: "${username}" → "${newName}".`);
        }
        db.close();
    });
} else if (command === 'list') {
    db.all(`SELECT id, username, display_name FROM users ORDER BY username`, (err, rows) => {
        if (err) {
            console.error('❌ Ошибка чтения пользователей:', err.message);
        } else if (rows.length === 0) {
            console.log('📭 Список администраторов пуст.');
        } else {
            console.log('👥 Администраторы:');
            rows.forEach(r => {
                const display = r.display_name ? ` (${r.display_name})` : '';
                console.log(`   ${r.id}. ${r.username}${display}`);
            });
        }
        db.close();
    });
} else {
    console.error(`❌ Неизвестная команда: ${command}`);
    process.exit(1);
}