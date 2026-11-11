// Versioned changes to the collection database, recorded in SQLite's `PRAGMA user_version`.
//
// Each migration runs once, in its own transaction together with the version bump, so a failed
// one leaves the database exactly as it was. Migrations are only ever appended: once released, an
// entry is never edited or reordered (a database out there may already be past it).

/**
 * Bring `db` up to `migrations.length`. `migrations[i]` takes the database from version i to i+1.
 * Returns { from, to }.
 *
 * A database already past the known versions (an older app started after a newer one, e.g. when the
 * desktop updater rolls back) is left alone and opened anyway: changes are additive, so the older
 * code still works with it.
 */
export function migrate(db, migrations, { log = console.warn } = {}) {
  const from = db.prepare('PRAGMA user_version').get().user_version;
  const target = migrations.length;
  if (from > target) {
    log(`The collection uses database version ${from}; this version of the app knows up to ${target}. Opening it anyway.`);
    return { from, to: from };
  }
  for (let v = from; v < target; v++) {
    db.exec('BEGIN');
    try {
      migrations[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Updating the collection database to version ${v + 1} failed: ${err.message}`, { cause: err });
    }
  }
  return { from, to: target };
}

/** The names of a table's columns. */
export const columnsOf = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));

/** Add a column unless it's there already (for migrations that must also fit databases made before versioning). */
export function addColumn(db, table, column, type) {
  if (!columnsOf(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
