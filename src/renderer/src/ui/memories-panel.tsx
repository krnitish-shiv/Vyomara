import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { DesktopMemory } from '../../../desktop/contracts.ts';

/**
 * What the assistant remembers across conversations. Each memory can be
 * removed; nothing here is a secret (those are never saved).
 */
export function MemoriesPanel({
  headingRef,
  onClose,
  assistantName = 'Vyom',
}: {
  readonly assistantName?: string;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly onClose: () => void;
}) {
  const [memories, setMemories] = useState<readonly DesktopMemory[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    headingRef.current?.focus();
    window.vyomara.listMemories().then(setMemories).catch(cause => {
      setError(cause instanceof Error ? cause.message : 'Memories could not be loaded.');
    });
  }, []);

  async function forget(id: string): Promise<void> {
    setError(undefined);
    try {
      setMemories(await window.vyomara.forgetMemory(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The memory could not be removed.');
    }
  }

  const general = memories?.filter(memory => memory.project === undefined) ?? [];
  const byProject = new Map<string, DesktopMemory[]>();
  for (const memory of memories ?? []) {
    if (memory.project === undefined) continue;
    byProject.set(memory.project, [...(byProject.get(memory.project) ?? []), memory]);
  }
  const row = (memory: DesktopMemory) => (
    <li key={memory.id} className="permission-row memory-row">
      <span>{memory.text}</span>
      <button className="history-delete" type="button" onClick={() => void forget(memory.id)} aria-label={`Forget: ${memory.text}`}>
        Forget
      </button>
    </li>
  );

  return (
    <aside id="memories-panel" className="activity-panel permissions-panel" aria-label="Memories">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">KEPT ACROSS CONVERSATIONS</p>
          <h2 ref={headingRef} tabIndex={-1}>Memories</h2>
        </div>
        <button className="history-close" type="button" onClick={onClose}>Close</button>
      </div>
      <div className="history-content" aria-live="polite">
        {memories === undefined && !error ? (
          <p className="history-message" role="status">Loading…</p>
        ) : memories && memories.length === 0 ? (
          <p className="history-message">
            Nothing yet. Say or type “yaad rakhna…” / “remember that…”, and {assistantName} will keep it for future conversations.
          </p>
        ) : (
          <>
            {general.length > 0 && (
              <>
                <p className="history-review-title">About you</p>
                <ul className="permission-list">{general.map(row)}</ul>
              </>
            )}
            {[...byProject.entries()].map(([project, items]) => (
              <div key={project}>
                <p className="history-review-title" title={project}>{project.split('/').at(-1) ?? project}</p>
                <ul className="permission-list">{items.map(row)}</ul>
              </div>
            ))}
          </>
        )}
        {error && <p className="history-message history-error" role="alert">{error}</p>}
        <p className="planned-note">Memories stay on this Mac. Passwords and keys are never saved.</p>
      </div>
    </aside>
  );
}
