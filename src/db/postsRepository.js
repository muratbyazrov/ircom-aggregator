import Database from 'better-sqlite3';

export function createPostsRepository(dbPath = 'data.db') {
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      msg_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      permalink TEXT,
      UNIQUE(source, msg_id)
    );
  `);

  ensureSchema(db);

  const upsertStmt = db.prepare(`
    INSERT INTO posts (
      source,
      msg_id,
      date,
      permalink,
      title,
      description,
      price_value,
      price_currency,
      contact_phone,
      contact_username,
      photo_path
    )
    VALUES (
      @source,
      @msg_id,
      @date,
      @permalink,
      @title,
      @description,
      @price_value,
      @price_currency,
      @contact_phone,
      @contact_username,
      @photo_path
    )
    ON CONFLICT(source, msg_id) DO UPDATE SET
      date = excluded.date,
      permalink = excluded.permalink,
      title = excluded.title,
      description = excluded.description,
      price_value = excluded.price_value,
      price_currency = excluded.price_currency,
      contact_phone = excluded.contact_phone,
      contact_username = excluded.contact_username,
      photo_path = COALESCE(excluded.photo_path, posts.photo_path)
  `);

  const clearStmt = db.prepare('DELETE FROM posts');

  return {
    upsert(post) {
      upsertStmt.run(post);
    },
    clear() {
      return clearStmt.run().changes;
    },
    close() {
      db.close();
    },
  };
}

function ensureSchema(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(posts)').all().map((row) => row.name));
  const addColumnIfMissing = (columnName, sqlType) => {
    if (!columns.has(columnName)) {
      db.exec(`ALTER TABLE posts ADD COLUMN ${columnName} ${sqlType}`);
      columns.add(columnName);
    }
  };

  addColumnIfMissing('title', 'TEXT');
  addColumnIfMissing('description', 'TEXT');
  addColumnIfMissing('price_value', 'INTEGER');
  addColumnIfMissing('price_currency', 'TEXT');
  addColumnIfMissing('contact_phone', 'TEXT');
  addColumnIfMissing('contact_username', 'TEXT');
  addColumnIfMissing('photo_path', 'TEXT');
}

