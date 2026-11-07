# ADR-0022: Undo approved file changes

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

Every file change is reviewed and approved before it is applied. Once
applied, there was no quick way back. The owner wants "undo karo" to work
the way it does when working with a person.

## Decision

1. **Record each applied change.** `FileOperationApprovalManager` reports
   each applied change (`onApplied`) to a `ChangeJournal`. The journal keeps
   one group per request, in memory, for the last 20 requests.
   - **Edits:** the exact original bytes, the file mode, and a hash of the
     new content.
   - **New files:** a hash of their content.
   - **New folders** and **items moved to Trash** are also recorded.
2. **Undo the newest group, newest change first.**
   - An edited file is restored only if its hash still matches what Vyomara
     wrote. A file the user changed later is left alone and reported.
   - A new file goes to the Trash.
   - A new folder is removed only if it is empty.
   - Trashed items are reported as "restore from Finder".
   - A group is undone once. The next undo goes one request further back.
3. **Triggers.**
   - The **↶ Undo these changes** button under the reply that made the
     changes.
   - Typing or saying "undo karo", "revert the last change" or "badlaav wapas
     karo" (`isUndoRequest`). The app handles this directly, so it does not
     depend on the model.
   - Undo is refused while a task runs.
4. **The model is told.** The next request in that session starts with a
   short note naming the restored files, so the model does not assume its
   changes are still there.

## Consequences

- Undo history does not survive quitting the app.
- Changes made by shell commands (`run_command`) are not recorded and cannot
  be undone this way. Git remains the tool for those.
