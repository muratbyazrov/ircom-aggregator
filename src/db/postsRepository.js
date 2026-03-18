import Database from 'better-sqlite3';

function resolveTableName(tableName) {
  return tableName === 'service_posts' ? 'service_posts' : 'posts';
}

export function createPostsRepository(dbPath = 'data.db', { tableName = 'posts' } = {}) {
  const db = new Database(dbPath);
  const table = resolveTableName(tableName);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      msg_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      permalink TEXT,
      UNIQUE(source, msg_id)
    );
  `);

  ensureSchema(db, table);

  // noinspection SqlDialectInspection,SqlNoDataSourceInspection
  const upsertStmt = db.prepare(`
    INSERT INTO ${table} (
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
      photo_path = COALESCE(excluded.photo_path, ${table}.photo_path),
      photo_paths = COALESCE(excluded.photo_paths, ${table}.photo_paths),
      backend_synced_at = CASE
        WHEN ${table}.date IS DISTINCT FROM excluded.date
          OR ${table}.permalink IS DISTINCT FROM excluded.permalink
          OR ${table}.title IS DISTINCT FROM excluded.title
          OR ${table}.description IS DISTINCT FROM excluded.description
          OR ${table}.price_value IS DISTINCT FROM excluded.price_value
          OR ${table}.dedupe_key IS DISTINCT FROM excluded.dedupe_key
          OR ${table}.sender_id IS DISTINCT FROM excluded.sender_id
          OR ${table}.content_hash IS DISTINCT FROM excluded.content_hash
          OR ${table}.contact_phone IS DISTINCT FROM excluded.contact_phone
          OR ${table}.contact_username IS DISTINCT FROM excluded.contact_username
          OR ${table}.contact_text IS DISTINCT FROM excluded.contact_text
          OR ${table}.category IS DISTINCT FROM excluded.category
          OR COALESCE(excluded.photo_path, ${table}.photo_path) IS DISTINCT FROM ${table}.photo_path
          OR COALESCE(excluded.photo_paths, ${table}.photo_paths) IS DISTINCT FROM ${table}.photo_paths
        THEN NULL
        ELSE ${table}.backend_synced_at
      END,
      backend_last_error = CASE
        WHEN ${table}.date IS DISTINCT FROM excluded.date
          OR ${table}.permalink IS DISTINCT FROM excluded.permalink
          OR ${table}.title IS DISTINCT FROM excluded.title
          OR ${table}.description IS DISTINCT FROM excluded.description
          OR ${table}.price_value IS DISTINCT FROM excluded.price_value
          OR ${table}.dedupe_key IS DISTINCT FROM excluded.dedupe_key
          OR ${table}.sender_id IS DISTINCT FROM excluded.sender_id
          OR ${table}.content_hash IS DISTINCT FROM excluded.content_hash
          OR ${table}.contact_phone IS DISTINCT FROM excluded.contact_phone
          OR ${table}.contact_username IS DISTINCT FROM excluded.contact_username
          OR ${table}.contact_text IS DISTINCT FROM excluded.contact_text
          OR ${table}.category IS DISTINCT FROM excluded.category
          OR COALESCE(excluded.photo_path, ${table}.photo_path) IS DISTINCT FROM ${table}.photo_path
          OR COALESCE(excluded.photo_paths, ${table}.photo_paths) IS DISTINCT FROM ${table}.photo_paths
        THEN NULL
        ELSE ${table}.backend_last_error
      END,
      backend_sync_target = CASE
        WHEN ${table}.date IS DISTINCT FROM excluded.date
          OR ${table}.permalink IS DISTINCT FROM excluded.permalink
          OR ${table}.title IS DISTINCT FROM excluded.title
          OR ${table}.description IS DISTINCT FROM excluded.description
          OR ${table}.price_value IS DISTINCT FROM excluded.price_value
          OR ${table}.dedupe_key IS DISTINCT FROM excluded.dedupe_key
          OR ${table}.sender_id IS DISTINCT FROM excluded.sender_id
          OR ${table}.content_hash IS DISTINCT FROM excluded.content_hash
          OR ${table}.contact_phone IS DISTINCT FROM excluded.contact_phone
          OR ${table}.contact_username IS DISTINCT FROM excluded.contact_username
          OR ${table}.contact_text IS DISTINCT FROM excluded.contact_text
          OR ${table}.category IS DISTINCT FROM excluded.category
          OR COALESCE(excluded.photo_path, ${table}.photo_path) IS DISTINCT FROM ${table}.photo_path
          OR COALESCE(excluded.photo_paths, ${table}.photo_paths) IS DISTINCT FROM ${table}.photo_paths
        THEN NULL
        ELSE ${table}.backend_sync_target
      END
  `);

  // noinspection SqlDialectInspection,SqlNoDataSourceInspection
  const clearStmt = db.prepare(`DELETE FROM ${table}`);
  const clearSyncedStmt = db.prepare(`DELETE FROM ${table} WHERE backend_synced_at IS NOT NULL`);
  const findExpiredStmt = db.prepare(`
    SELECT
      source,
      msg_id,
      date,
      photo_path,
      photo_paths
    FROM ${table}
    WHERE date < @cutoff_date
    ORDER BY date ASC
  `);
  const deleteExpiredStmt = db.prepare(`DELETE FROM ${table} WHERE date < @cutoff_date`);
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
    FROM ${table}
    ORDER BY date DESC, id DESC
  `);
  const findMissingDedupeKeyStmt = db.prepare(`
    SELECT
      id,
      COALESCE(description, title, '') AS text
    FROM ${table}
    WHERE dedupe_key IS NULL
       OR TRIM(dedupe_key) = ''
    ORDER BY id ASC
  `);
  const updateDedupeKeyStmt = db.prepare(`
    UPDATE ${table}
    SET dedupe_key = @dedupe_key
    WHERE id = @id
  `);
  const updateStoredPhotosStmt = db.prepare(`
    UPDATE ${table}
    SET
      photo_path = @photo_path,
      photo_paths = @photo_paths
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
    FROM ${table}
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
      backend_last_error,
      backend_sync_target
    FROM ${table}
    WHERE backend_synced_at IS NULL
       OR backend_sync_target IS DISTINCT FROM @backend_sync_target
    ORDER BY date ASC, id ASC
  `);
  const markBackendSyncSuccessStmt = db.prepare(`
    UPDATE ${table}
    SET
      backend_synced_at = @backend_synced_at,
      backend_last_error = NULL,
      backend_sync_target = @backend_sync_target
    WHERE id = @id
  `);
  const markBackendSyncFailureStmt = db.prepare(`
    UPDATE ${table}
    SET
      backend_synced_at = NULL,
      backend_last_error = @backend_last_error
    WHERE id = @id
  `);
  const findDuplicateWithSenderStmt = db.prepare(`
    SELECT 1
    FROM ${table}
    WHERE source = @source
      AND sender_id = @sender_id
      AND content_hash = @content_hash
      AND msg_id <> @msg_id
    LIMIT 1
  `);
  const findDuplicateWithoutSenderStmt = db.prepare(`
    SELECT 1
    FROM ${table}
    WHERE source = @source
      AND sender_id IS NULL
      AND content_hash = @content_hash
      AND msg_id <> @msg_id
    LIMIT 1
  `);
  const findFuzzyDuplicateWithSenderStmt = db.prepare(`
    SELECT 1
    FROM ${table}
    WHERE sender_id = @sender_id
      AND dedupe_key = @dedupe_key
      AND msg_id <> @msg_id
    LIMIT 1
  `);
  const findFuzzyDuplicateWithPhoneStmt = db.prepare(`
    SELECT 1
    FROM ${table}
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
    updateStoredPhotos({ id, photoPath = null, photoPaths = null }) {
      return updateStoredPhotosStmt.run({
        id,
        photo_path: photoPath,
        photo_paths: photoPaths,
      }).changes;
    },
    getPostBySourceAndMsgId({ source, msgId }) {
      return findBySourceAndMsgIdStmt.get({
        source,
        msg_id: msgId,
      }) || null;
    },
    listPendingBackendSync({ backendSyncTarget = null } = {}) {
      return listPendingBackendSyncStmt.all({
        backend_sync_target: backendSyncTarget,
      });
    },
    markBackendSyncSuccess({ id, syncedAt = new Date().toISOString(), backendSyncTarget = null }) {
      return markBackendSyncSuccessStmt.run({
        id,
        backend_synced_at: syncedAt,
        backend_sync_target: backendSyncTarget,
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
      const stmt = db.prepare(`DELETE FROM ${table} WHERE id IN (${placeholders})`);
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

function ensureSchema(db, table) {
  // noinspection SqlDialectInspection,SqlNoDataSourceInspection
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  const addColumnIfMissing = (columnName, sqlType) => {
    if (!columns.has(columnName)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnName} ${sqlType}`);
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
  addColumnIfMissing('backend_sync_target', 'TEXT');
}
