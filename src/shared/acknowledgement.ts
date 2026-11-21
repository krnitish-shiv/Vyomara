/**
 * A short spoken line for the moment a twin starts working in voice mode,
 * before the first tool runs, so the user hears that the request landed
 * instead of waiting in silence ("speak first, then work"). Pure code.
 */
import { isTeamMemberId, TEAM } from '../agent/team.ts';

/** `label` is the tool activity label, e.g. "Handing to Khoj: …" for delegate. */
export function acknowledgementFor(toolId: string, label: string, gender: 'male' | 'female'): string {
  const verb = gender === 'female' ? 'rahi' : 'raha';
  switch (toolId) {
    case 'delegate': {
      const id = /^Handing to (\w+)/u.exec(label)?.[1]?.toLowerCase();
      return isTeamMemberId(id) ? `${TEAM[id].name} ko de ${verb} hoon.` : `Team ko de ${verb} hoon.`;
    }
    case 'web_search':
    case 'fetch_url':
    case 'news_headlines':
    case 'weather':
    case 'software_version':
    case 'currency_convert':
      return `Ek second, dekh ${verb} hoon.`;
    case 'edit_file':
    case 'multi_edit':
    case 'write_file':
    case 'run_command':
    case 'git_commit':
      return `Theek hai, kar ${verb} hoon.`;
    case 'open_application':
    case 'open_url':
    case 'control_application':
    case 'vscode':
    case 'mac_control':
    case 'browser':
      return `Haan, khol ${verb} hoon.`;
    case 'update_plan':
      return `Theek hai, plan bana ${verb} hoon.`;
    default:
      return `Ek second, dekh ${verb} hoon.`;
  }
}
