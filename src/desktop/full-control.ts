/**
 * Full control (the owner's choice, 2026-11-22): the twins act without asking
 * for each step. Web searches and reads, opening apps and links, controlling
 * windows and the Mac, MCP tools, terminal commands, and file edits all run
 * at once. Two kinds of step still ask, because they cannot be taken back:
 * deleting files (typed DELETE, handled by the file review), and the
 * dangerous commands below. Pure code, so the rules can be tested.
 */
import type { ActionApprovalPort, ActionProposal, ApprovalDecision } from '../tools/action-tools.ts';

/** Commands that can destroy data, the system, or shared history, or run code from the internet. */
const DANGEROUS_COMMAND = new RegExp([
  String.raw`(?:^|[\s;&|(])sudo\s`,
  String.raw`(?:^|[\s;&|(])rm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(?:/|~|\$HOME|\*|\.\.?(?:\s|$))`,
  String.raw`(?:^|[\s;&|(])rm\s+(?:-[a-zA-Z]*\s+)*(?:/|~/?)(?:\s|$)`,
  String.raw`(?:^|[\s;&|(])(?:mkfs|fdisk|diskutil\s+(?:erase|partition|zero|secureErase)|dd\s+.*\bof=)`,
  String.raw`(?:^|[\s;&|(])(?:shutdown|reboot|halt)\b`,
  String.raw`(?:^|[\s;&|(])git\s+push\b.*(?:--force|-f\b|--delete|\s:)`,
  String.raw`(?:^|[\s;&|(])git\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*f|filter-branch|reflog\s+expire)`,
  String.raw`(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|)sh\b`,
  String.raw`(?:^|[\s;&|(])(?:chmod|chown)\s+-R\s+\S+\s+(?:/|~)(?:\s|$)`,
  String.raw`(?:^|[\s;&|(])launchctl\s+(?:unload|remove|bootout)`,
  String.raw`(?:^|[\s;&|(])(?:killall|pkill)\s+(?:-9\s+)?(?:Finder|Dock|WindowServer|loginwindow)\b`,
  String.raw`>\s*/dev/(?:disk|rdisk)`,
  String.raw`(?:^|[\s;&|(])(?:npm|pnpm|yarn)\s+publish\b`,
].join('|'), 'u');

/** Whether a dangerous command still needs the user's approval in full control. */
export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND.test(command);
}

/** Whether full control runs this step without asking. */
export function fullControlAllows(action: ActionProposal): boolean {
  switch (action.kind) {
    case 'command':
      return !isDangerousCommand(action.command);
    case 'app-control':
      // Quitting may lose unsaved work in that app.
      return action.action !== 'quit';
    case 'web':
    case 'url':
    case 'application':
    case 'mcp':
    case 'system':
      return true;
    default:
      return false;
  }
}

/**
 * An approval port that answers allowed steps itself while full control is
 * on, and asks the user (through `inner`) for everything else.
 */
export class FullControlApproval implements ActionApprovalPort {
  readonly #inner: ActionApprovalPort;
  readonly #enabled: () => boolean;

  constructor(inner: ActionApprovalPort, enabled: () => boolean) {
    this.#inner = inner;
    this.#enabled = enabled;
  }

  request(action: ActionProposal, signal: AbortSignal): Promise<ApprovalDecision> {
    if (this.#enabled() && fullControlAllows(action)) return Promise.resolve(true);
    return this.#inner.request(action, signal);
  }
}
