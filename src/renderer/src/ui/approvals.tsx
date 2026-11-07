import type { RefObject } from 'react';
import type { DesktopActionProposal, DesktopFileOperationProposal } from '../../../desktop/contracts.ts';
import { diffHunks, diffStats } from '../../../shared/diff.ts';

export function FileDiff({ before, after }: { readonly before: string; readonly after: string }) {
  const hunks = diffHunks(before, after);
  const stats = diffStats(before, after);
  if (hunks.length === 0) return <p className="file-operation-warning">No textual changes.</p>;
  return (
    <div className="file-diff" aria-label={`${stats.added} lines added, ${stats.removed} lines removed`}>
      <p className="file-diff-stats"><span className="diff-added">+{stats.added}</span> <span className="diff-removed">−{stats.removed}</span></p>
      {hunks.map((hunk, hunkIndex) => (
        <pre key={hunkIndex} className="file-diff-hunk">
          <span className="diff-header">{hunk.header}{'\n'}</span>
          {hunk.lines.map((line, lineIndex) => (
            <span key={lineIndex} className={`diff-line diff-${line.type}`}>
              {line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '} {line.text}{'\n'}
            </span>
          ))}
        </pre>
      ))}
    </div>
  );
}

const FILE_OPERATION_LABELS: Readonly<Record<DesktopFileOperationProposal['operation'], string>> = {
  'create-file': 'Create file',
  'create-directory': 'Create folder',
  'edit-file': 'Edit file',
  delete: 'Move to Trash',
};

/** Review card for one proposed file change; deletions need DELETE typed. */
export function FileOperationCard({
  proposal,
  confirmation,
  busy,
  anyBusy,
  cardRef,
  onConfirmationChange,
  onApprove,
  onReject,
  onOpenDiff,
  onApproveAll,
}: {
  /** Show this change as a side-by-side diff in VS Code. */
  readonly onOpenDiff?: () => void;
  /** Approve this and every later edit in the task. */
  readonly onApproveAll?: () => void;
  readonly proposal: DesktopFileOperationProposal;
  readonly confirmation: string;
  readonly busy: boolean;
  readonly anyBusy: boolean;
  readonly cardRef?: RefObject<HTMLElement | null> | undefined;
  readonly onConfirmationChange: (value: string) => void;
  readonly onApprove: () => void;
  readonly onReject: () => void;
}) {
  const label = FILE_OPERATION_LABELS[proposal.operation];
  const isDelete = proposal.operation === 'delete';
  return (
    <section className="file-operation-review" aria-label={`${label} approval`} ref={cardRef}>
      <p className="eyebrow">YOUR REVIEW REQUIRED</p>
      <h3>{label}</h3>
      <code className="file-operation-path">{proposal.path}</code>
      {isDelete ? (
        <>
          <p className="file-operation-warning">
            This item will be moved to the system Trash, not permanently erased.
            {proposal.targetType === 'directory' && ' The folder move includes its contents.'}
          </p>
          <label className="file-operation-confirm-label" htmlFor={`file-delete-${proposal.id}`}>
            Type DELETE to confirm this item
          </label>
          <input
            id={`file-delete-${proposal.id}`}
            className="file-operation-confirm-input"
            value={confirmation}
            onChange={event => onConfirmationChange(event.target.value)}
            autoComplete="off"
            disabled={busy}
          />
        </>
      ) : proposal.proposedContent !== undefined
        ? <FileDiff before={proposal.currentContent ?? ''} after={proposal.proposedContent} />
        : <p className="file-operation-warning">An empty folder will be created.</p>}
      <div className="file-operation-actions">
        <button
          className={isDelete ? 'history-danger' : 'file-operation-approve'}
          type="button"
          onClick={onApprove}
          disabled={busy || anyBusy || (isDelete && confirmation !== 'DELETE')}
        >
          {busy ? 'Applying…' : isDelete ? 'Move to Trash' : 'Approve and apply'}
        </button>
        {onApproveAll && !isDelete && (
          <button
            className="file-operation-approve-all"
            type="button"
            onClick={onApproveAll}
            disabled={busy || anyBusy}
            title="Apply this change and the rest of this task's edits without asking again. Deletions still need DELETE."
          >
            Approve all edits in this task
          </button>
        )}
        <button className="file-operation-reject" type="button" onClick={onReject} disabled={busy || anyBusy}>
          Reject
        </button>
        {onOpenDiff && !isDelete && proposal.proposedContent !== undefined && (
          <button className="file-operation-diff" type="button" onClick={onOpenDiff} title="Show this change side by side in VS Code">
            <span aria-hidden="true">⇄</span> Open in VS Code
          </button>
        )}
      </div>
    </section>
  );
}

/** Approval card for a shell command, application launch, or web page. */
export function ActionApprovalCard({
  proposal,
  busy,
  cardRef,
  onDecide,
  assistantName = 'Vyom',
}: {
  /** The selected assistant's name (Vyom or Vyomara). */
  readonly assistantName?: string;
  readonly proposal: DesktopActionProposal;
  readonly busy: boolean;
  readonly cardRef?: RefObject<HTMLElement | null> | undefined;
  readonly onDecide: (approve: boolean, always?: boolean) => void;
}) {
  const title = proposal.kind === 'command'
    ? 'Run this command?'
    : proposal.kind === 'application'
      ? `Open ${proposal.application}?`
      : proposal.kind === 'web'
        ? proposal.operation === 'search' ? 'Search the web?' : `Let ${assistantName} read this web page?`
        : proposal.kind === 'app-control'
          ? `${proposal.action.replace(/^./u, letter => letter.toUpperCase())} ${proposal.application}?`
          : 'Open this web page?';
  const remember = proposal.kind === 'command'
    ? { label: 'Always allow here', title: 'Run now, and run this exact command in this folder without asking again until Vyomara quits' }
    : proposal.kind === 'web'
      ? { label: `Always allow ${proposal.host}`, title: `Read pages from ${proposal.host} without asking again. Revoke anytime in Permissions.` }
      : proposal.kind === 'application'
        ? { label: `Always allow ${proposal.application}`, title: `Open ${proposal.application} without asking again. Revoke anytime in Permissions.` }
        : proposal.kind === 'app-control'
          ? proposal.action === 'quit'
            ? undefined
            : { label: `Always allow ${proposal.application}`, title: `Open, focus, hide, and minimize ${proposal.application} without asking again (quitting still asks).` }
          : { label: `Always allow ${proposal.application ?? 'browser'}`, title: `Open web pages in ${proposal.application ?? 'your default browser'} without asking again. Revoke anytime in Permissions.` };
  return (
    <section className="file-operation-review action-review" aria-label={title} ref={cardRef}>
      <p className="eyebrow">YOUR APPROVAL REQUIRED</p>
      <h3>{title}</h3>
      {proposal.kind === 'command' && (
        <>
          <pre className="action-command"><code>{proposal.command}</code></pre>
          <p className="file-operation-warning">
            Runs in <code>{proposal.cwd}</code> with your user permissions · stops after {proposal.timeoutSeconds}s.
          </p>
        </>
      )}
      {proposal.kind === 'application' && (
        <p className="file-operation-warning">
          {proposal.target
            ? <>Opens <code>{proposal.target}</code>{proposal.line ? <> at line {proposal.line}</> : null} in {proposal.application}.</>
            : `Launches ${proposal.application}.`}
        </p>
      )}
      {proposal.kind === 'url' && (
        <>
          <code className="file-operation-path">{proposal.url}</code>
          <p className="file-operation-warning">
            Opens in {proposal.application ?? 'your default browser'}. The website ({new URL(proposal.url).hostname}) receives this address, including any search words.
          </p>
        </>
      )}
      {proposal.kind === 'app-control' && (
        <p className="file-operation-warning">
          {proposal.action === 'quit'
            ? `${proposal.application} will close. It may ask to save unsaved work.`
            : `Only changes the ${proposal.application} window; nothing is closed or deleted.`}
        </p>
      )}
      {proposal.kind === 'web' && (
        <>
          <code className="file-operation-path">{proposal.target}</code>
          <p className="file-operation-warning">
            Vyomara will contact {proposal.host} from this Mac, which receives this {proposal.operation === 'search' ? 'search text' : 'address'}. Page text is then sent to your local model.
          </p>
        </>
      )}
      <div className="file-operation-actions">
        <button className="file-operation-approve" type="button" onClick={() => onDecide(true)} disabled={busy}>
          {proposal.kind === 'command' ? 'Run' : proposal.kind === 'web' || proposal.kind === 'app-control' ? 'Allow' : 'Open'}
        </button>
        {remember && (
          <button className="file-operation-reject" type="button" onClick={() => onDecide(true, true)} disabled={busy} title={remember.title}>
            {remember.label}
          </button>
        )}
        <button className="file-operation-reject" type="button" onClick={() => onDecide(false)} disabled={busy}>
          Don’t allow
        </button>
      </div>
    </section>
  );
}
