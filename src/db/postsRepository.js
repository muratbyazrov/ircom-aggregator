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
      photo_path,
      photo_paths
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
      @photo_path,
      @photo_paths
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
      photo_path = COALESCE(excluded.photo_path, posts.photo_path),
      photo_paths = COALESCE(excluded.photo_paths, posts.photo_paths),
      backend_synced_at = CASE
        WHEN posts.date IS DISTINCT FROM excluded.date
          OR posts.permalink IS DISTINCT FROM excluded.permalink
          OR posts.title IS DISTINCT FROM excluded.title
          OR posts.description IS DISTINCT FROM excluded.description
          OR posts.price_value IS DISTINCT FROM excluded.price_value
          OR posts.dedupe_key IS DISTINCT FROM excluded.dedupe_key
          OR posts.sender_id IS DISTINCT FROM excluded.sender_id
          OR posts.content_hash IS DISTINCT FROM excluded.content_hash
          OR posts.contact_phone IS DISTINCT FROM excluded.contact_phone
          OR posts.contact_username IS DISTINCT FROM excluded.contact_username
          OR posts.contact_text IS DISTINCT FROM excluded.contact_text
          OR posts.category IS DISTINCT FROM excluded.category
          OR COALESCE(excluded.photo_path, posts.photo_path) IS DISTINCT FROM posts.photo_path
          OR COALESCE(excluded.photo_paths, posts.photo_paths) IS DISTINCT FROM posts.photo_paths
        THEN NULL
        ELSE posts.backend_synced_at
      END,
      backend_last_error = CASE
        WHEN posts.date IS DISTINCT FROM excluded.date
          OR posts.permalink IS DISTINCT FROM excluded.permalink
          OR posts.title IS DISTINCT FROM excluded.title
          OR posts.description IS DISTINCT FROM excluded.description
          OR posts.price_value IS DISTINCT FROM excluded.price_value
          OR posts.dedupe_key IS DISTINCT FROM excluded.dedupe_key
          OR posts.sender_id IS DISTINCT FROM excluded.sender_id
          OR posts.content_hash IS DISTINCT FROM excluded.content_hash
          OR posts.contact_phone IS DISTINCT FROM excluded.contact_phone
          OR posts.contact_username IS DISTINCT FROM excluded.contact_username
          OR posts.contact_text IS DISTINCT FROM excluded.contact_text
          OR posts.category IS DISTINCT FROM excluded.category
          OR COALESCE(excluded.photo_path, posts.photo_path) IS DISTINCT FROM posts.photo_path
          OR COALESCE(excluded.photo_paths, posts.photo_paths) IS DISTINCT FROM posts.photo_paths
        THEN NULL
        ELSE posts.backend_last_error
      END
  `);

  // noinspection SqlDialectInspection,SqlNoDataSourceInspection
  const clearStmt = db.prepare('DELETE FROM posts');
  const clearSyncedStmt = db.prepare('DELETE FROM posts WHERE backend_synced_at IS NOT NULL');
  const findExpiredStmt = db.prepare(`
    SELECT
      source,
      msg_id,
      date,
      photo_path,
      photo_paths
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
      photo_paths,
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
      photo_paths,
      sender_id,
      content_hash,
      dedupe_key,
      contact_phone,
      contact_username,
      contact_text,
      category,
      description,
      price_value,
      permalink,
      backend_synced_at,
      backend_last_error,
      photo_path,
      photo_paths
    FROM posts
    WHERE source = @source
      AND msg_id = @msg_id
    LIMIT 1
  `);
  const listPendingBackendSyncStmt = db.prepare(`
    SELECT
      id,
      source,
      msg_id,
      date,
      permalink,
      title,
      description,
      price_value,
      photo_path,
      photo_paths,
      sender_id,
      content_hash,
      dedupe_key,
      contact_phone,
      contact_username,
      contact_text,
      category,
      backend_synced_at,
      backend_last_error
    FROM posts
    WHERE backend_synced_at IS NULL
    ORDER BY date ASC, id ASC
  `);
  const markBackendSyncSuccessStmt = db.prepare(`
    UPDATE posts
    SET
      backend_synced_at = @backend_synced_at,
      backend_last_error = NULL
    WHERE id = @id
  `);
  const markBackendSyncFailureStmt = db.prepare(`
    UPDATE posts
    SET
      backend_synced_at = NULL,
      backend_last_error = @backend_last_error
    WHERE id = @id
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
    clear({ syncedOnly = false } = {}) {
      return syncedOnly ? clearSyncedStmt.run().changes : clearStmt.run().changes;
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
    listPendingBackendSync() {
      return listPendingBackendSyncStmt.all();
    },
    markBackendSyncSuccess({ id, syncedAt = new Date().toISOString() }) {
      return markBackendSyncSuccessStmt.run({
        id,
        backend_synced_at: syncedAt,
      }).changes;
    },
    markBackendSyncFailure({ id, error }) {
      return markBackendSyncFailureStmt.run({
        id,
        backend_last_error: String(error || '').trim() || 'Unknown sync error',
      }).changes;
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
  addColumnIfMissing('photo_paths', 'TEXT');
  addColumnIfMissing('backend_synced_at', 'TEXT');
  addColumnIfMissing('backend_last_error', 'TEXT');
}
