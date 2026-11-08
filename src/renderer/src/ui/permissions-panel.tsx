import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { DesktopPermissions } from '../../../desktop/contracts.ts';

/** One-click grants for the apps people use most with Vyom. */
const QUICK_GRANTS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'app:Visual Studio Code', label: 'Open Visual Studio Code' },
  { id: 'app:Google Chrome', label: 'Open Google Chrome' },
  { id: 'browser:Google Chrome', label: 'Open web pages in Google Chrome' },
  { id: 'browser:default browser', label: 'Open web pages in your default browser' },
  { id: 'app:Finder', label: 'Open Finder' },
  { id: 'app:Terminal', label: 'Open Terminal' },
];

/**
 * Standing permissions: actions the user allowed once so Vyom does not ask
 * again. File changes and deletions are never covered.
 */
export function PermissionsPanel({
  headingRef,
  onClose,
  assistantName = 'Vyom',
}: {
  /** The selected assistant's name (Vyom or Vyomara). */
  readonly assistantName?: string;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly onClose: () => void;
}) {
  const [state, setState] = useState<DesktopPermissions>();
  const [error, setError] = useState<string>();
  const [pattern, setPattern] = useState('');
  const [folder, setFolder] = useState('');

  useEffect(() => {
    headingRef.current?.focus();
    window.vyomara.listPermissions().then(setState).catch(cause => {
      setError(cause instanceof Error ? cause.message : 'Permissions could not be loaded.');
    });
  }, []);

  async function change(action: () => Promise<DesktopPermissions>): Promise<void> {
    setError(undefined);
    try {
      setState(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The permission could not be changed.');
    }
  }

  const granted = new Set(state?.grants.map(grant => grant.id));
  const quick = QUICK_GRANTS.filter(grant => !granted.has(grant.id));

  return (
    <aside id="permissions-panel" className="activity-panel permissions-panel" aria-label="Permissions">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">ALLOW ONCE, NOT EVERY TIME</p>
          <h2 ref={headingRef} tabIndex={-1}>Permissions</h2>
        </div>
        <button className="history-close" type="button" onClick={onClose}>Close</button>
      </div>
      <div className="history-content" aria-live="polite">
        <p className="history-review-title">{assistantName} does these without asking</p>
        {state === undefined && !error ? (
          <p className="history-message" role="status">Loading…</p>
        ) : state && state.grants.length === 0 ? (
          <p className="history-message">Nothing yet. Allow something below, or choose “Always allow” on an approval card.</p>
        ) : (
          <ul className="permission-list">
            {state?.grants.map(grant => (
              <li key={grant.id} className="permission-row">
                <span>✓ {grant.label}</span>
                <button className="history-delete" type="button" onClick={() => void change(() => window.vyomara.revokePermission(grant.id))}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}

        {quick.length > 0 && (
          <>
            <p className="history-review-title">Quick allow</p>
            <ul className="permission-list">
              {quick.map(grant => (
                <li key={grant.id} className="permission-row">
                  <span>{grant.label}</span>
                  <button className="history-action" type="button" onClick={() => void change(() => window.vyomara.grantPermission(grant.id))}>
                    Allow
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="history-review-title">Allow a command</p>
        <form
          className="permission-command-form"
          onSubmit={event => {
            event.preventDefault();
            void change(() => window.vyomara.grantPermission(`command:${folder.trim()}\t${pattern.trim()}`)).then(() => setPattern(''));
          }}
        >
          <input value={pattern} onChange={event => setPattern(event.target.value)} placeholder="pnpm test*" aria-label="Command, or a prefix ending in *" maxLength={300} />
          <input value={folder} onChange={event => setFolder(event.target.value)} placeholder="/Users/you/Projects/app" aria-label="Project folder (absolute path)" maxLength={4000} />
          <button className="history-action" type="submit" disabled={!pattern.trim() || !folder.trim().startsWith('/')}>Allow</button>
          <small>End with * to allow anything that starts the same way, like <code>pnpm test*</code>. Chained commands (&amp;&amp;, ;, |) always ask.</small>
        </form>
        {error && <p className="history-message history-error" role="alert">{error}</p>}
      </div>
      <p className="history-privacy">
        Always reviewed: file edits, new files, and deletions. Shell commands can be allowed per folder from their card, until Vyomara quits.
        Every action still appears in the step list and under “Verified actions”.
      </p>
    </aside>
  );
}
