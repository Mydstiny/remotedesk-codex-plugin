import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Fault, requireThat } from './errors.mjs';
// SQLite's OS lock is released on process death, unlike an orphaned lock file.
// This gate only serializes start/recover; it contains no data or credentials.
export async function withLifecycleLock(directory, action, name = 'lifecycle') {
  requireThat(['lifecycle', 'service', 'installation'].includes(name), 'LIFECYCLE_LOCK_INVALID');
  const db = new DatabaseSync(join(directory, name + '.sqlite'));
  let held = false;
  try {
    const deadline = Date.now() + 60000;
    for (;;) {
      try {
        db.exec('BEGIN IMMEDIATE');
        held = true;
        break;
      } catch (e) {
        if (e.errcode !== 5 && e.errcode !== 6) throw e;
        if (Date.now() >= deadline) throw new Fault('LIFECYCLE_BUSY');
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const result = await action();
    db.exec('COMMIT');
    held = false;
    return result;
  } finally {
    if (held) db.exec('ROLLBACK');
    db.close();
  }
}
