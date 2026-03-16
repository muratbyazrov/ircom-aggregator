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

  // noinspection SqlDialectInspection,SqlNoDataSourceInspection
  const upsertStmt = db.prepare(`
    INSERT INTO posts (
      source,
      msg_id,
      date,
      permalink,
      title,
      description,
      price_value,
      dedupe_key,
      sender_id,
      content_hash,
      contact_phone,
      contact_username,
      contact_text,
      category,
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
      @dedupe_key,
      @sender_id,
      @content_hash,
      @contact_phone,
      @contact_username,
      @contact_text,
      @category,
      @photo_path
    )
    ON CONFLICT(source, msg_id) DO UPDATE SET
      date = excluded.date,
      permalink = excluded.permalink,
      title = excluded.title,
      description = excluded.description,
      price_value = excluded.price_value,
      dedupe_key = excluded.dedupe_key,
      sender_id = excluded.sender_id,
      content_hash = excluded.content_hash,
      contact_phone = excluded.contact_phone,
      contact_username = excluded.contact_username,
      contact_text = excluded.contact_text,
      category = excluded.category,
      photo_path = COALESCE(excluded.photo_path, posts.photo_path)
  `);

  // noinspection SqlDialectInspection,SqlNoDataSourceInspection
  const clearStmt = db.prepare('DELETE FROM posts');
  const findExpiredStmt = db.prepare(`
    SELECT
      source,
      msg_id,
      date,
      photo_path
    FROM posts
    WHERE date < @cutoff_date
    ORDER BY date ASC
  `);
  const deleteExpiredStmt = db.prepare('DELETE FROM posts WHERE date < @cutoff_date');
  const listPostsForDedupeStmt = db.prepare(`
    SELECT
      id,
      source,
      msg_id,
      date,
      title,
      photo_path,
      sender_id,
      content_hash,
      dedupe_key,
      contact_phone,
      contact_username
    FROM posts
    ORDER BY date DESC, id DESC
  `);
  const findMissingDedupeKeyStmt = db.prepare(`
    SELECT
      id,
      COALESCE(description, title, '') AS text
    FROM posts
    WHERE dedupe_key IS NULL
       OR TRIM(dedupe_key) = ''
    ORDER BY id ASC
  `);
  const updateDedupeKeyStmt = db.prepare(`
    UPDATE posts
    SET dedupe_key = @dedupe_key
    WHERE id = @id
  `);
  const findBySourceAndMsgIdStmt = db.prepare(`
    SELECT
      id,
      source,
      msg_id,
      date,
      title,
      photo_path,
      sender_id,
      content_hash,
      dedupe_key,
      contact_phone,
      contact_username
    FROM posts
    WHERE source = @source
      AND msg_id = @msg_id
    LIMIT 1
  `);
  const findDuplicateWithSenderStmt = db.prepare(`
    SELECT 1
    FROM posts
    WHERE source = @source
      AND sender_id = @sender_id
      AND content_hash = @content_hash
      AND msg_id <> @msg_id
    LIMIT 1
  `);
  const findDuplicateWithoutSenderStmt = db.prepare(`
    SELECT 1
    FROM posts
    WHERE source = @source
      AND sender_id IS NULL
      AND content_hash = @content_hash
      AND msg_id <> @msg_id
    LIMIT 1
  `);
  const findFuzzyDuplicateWithSenderStmt = db.prepare(`
    SELECT 1
    FROM posts
    WHERE sender_id = @sender_id
      AND dedupe_key = @dedupe_key
      AND msg_id <> @msg_id
    LIMIT 1
  `);
  const findFuzzyDuplicateWithPhoneStmt = db.prepare(`
    SELECT 1
    FROM posts
    WHERE contact_phone = @contact_phone
      AND dedupe_key = @dedupe_key
      AND msg_id <> @msg_id
    LIMIT 1
  `);

  return {
    upsert(post) {
      upsertStmt.run(post);
    },
    clear() {
      return clearStmt.run().changes;
    },
    getExpiredBefore(cutoffDate) {
      return findExpiredStmt.all({ cutoff_date: cutoffDate });
    },
    deleteExpiredBefore(cutoffDate) {
      return deleteExpiredStmt.run({ cutoff_date: cutoffDate }).changes;
    },
    listPostsForDedupe() {
      return listPostsForDedupeStmt.all();
    },
    getPostsMissingDedupeKey() {
      return findMissingDedupeKeyStmt.all();
    },
    updateDedupeKey({ id, dedupeKey }) {
      return updateDedupeKeyStmt.run({
        id,
        dedupe_key: dedupeKey,
      }).changes;
    },
    getPostBySourceAndMsgId({ source, msgId }) {
      return findBySourceAndMsgIdStmt.get({
        source,
        msg_id: msgId,
      }) || null;
    },
    deletePostsByIds(ids) {
      if (!Array.isArray(ids) || ids.length === 0) return 0;

      const placeholders = ids.map(() => '?').join(', ');
      const stmt = db.prepare(`DELETE FROM posts WHERE id IN (${placeholders})`);
      return stmt.run(...ids).changes;
    },
    hasDuplicateByContent({ source, msgId, senderId, contentHash }) {
      if (!source || !contentHash) return false;

      if (senderId) {
        return Boolean(findDuplicateWithSenderStmt.get({
          source,
          sender_id: senderId,
          content_hash: contentHash,
          msg_id: msgId,
        }));
      }

      return Boolean(findDuplicateWithoutSenderStmt.get({
        source,
        content_hash: contentHash,
        msg_id: msgId,
      }));
    },
    hasFuzzyDuplicate({ msgId, senderId, contactPhone, dedupeKey }) {
      if (!dedupeKey) return false;

      if (senderId) {
        return Boolean(findFuzzyDuplicateWithSenderStmt.get({
          sender_id: senderId,
          dedupe_key: dedupeKey,
          msg_id: msgId,
        }));
      }

      if (contactPhone) {
        return Boolean(findFuzzyDuplicateWithPhoneStmt.get({
          contact_phone: contactPhone,
          dedupe_key: dedupeKey,
          msg_id: msgId,
        }));
      }

      return false;
    },
    close() {
      db.close();
    },
  };
}

function ensureSchema(db) {
  // noinspection SqlDialectInspection,SqlNoDataSourceInspection
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
  addColumnIfMissing('dedupe_key', 'TEXT');
  addColumnIfMissing('sender_id', 'TEXT');
  addColumnIfMissing('content_hash', 'TEXT');
  addColumnIfMissing('contact_phone', 'TEXT');
  addColumnIfMissing('contact_username', 'TEXT');
  addColumnIfMissing('contact_text', 'TEXT');
  addColumnIfMissing('category', 'TEXT');
  addColumnIfMissing('photo_path', 'TEXT');
}
