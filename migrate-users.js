const { runQuery, allQuery, initDb } = require('./src/database');

async function migrate() {
  console.log('Migrating users table to support director role, must_change_password, and permissions...');
  try {
    await runQuery(`
      CREATE TABLE IF NOT EXISTS users_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'director', 'doctor', 'receptionist')),
        doctor_id INTEGER,
        is_active INTEGER DEFAULT 1,
        must_change_password INTEGER DEFAULT 0,
        permissions TEXT,
        last_login DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE SET NULL
      )
    `);

    await runQuery(`
      INSERT OR IGNORE INTO users_v2 (id, username, email, password_hash, salt, full_name, role, doctor_id, is_active, last_login, created_at)
      SELECT id, username, email, password_hash, salt, full_name, role, doctor_id, is_active, last_login, created_at FROM users
    `);

    await runQuery('DROP TABLE users');
    await runQuery('ALTER TABLE users_v2 RENAME TO users');
    console.log('Table schema migrated successfully!');
  } catch (err) {
    console.log('Migration step note:', err.message);
  }

  await initDb();
  const users = await allQuery('SELECT id, username, role, doctor_id, full_name, is_active, must_change_password FROM users');
  console.log('Active users in database:\n', users);
}

migrate().catch(console.error);
