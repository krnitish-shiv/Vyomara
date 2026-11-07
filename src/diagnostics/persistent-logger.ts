import type { Logger } from '../types.ts';
import type { SqliteStore } from '../storage/sqlite-store.ts';

export function withPersistentAudit(logger: Logger, store: SqliteStore): Logger {
  return {
    emit(event) {
      store.appendAuditEvent(event);
      logger.emit(event);
    },
    failure(error) {
      logger.failure(error);
    },
  };
}
