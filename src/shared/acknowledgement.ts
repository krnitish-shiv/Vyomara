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

/** What a tool is doing, as a short Hinglish phrase ("weather dekh"), for progress lines. */
const DOING: Readonly<Record<string, string>> = {
  web_search: 'web par dhoondh', fetch_url: 'page padh', news_headlines: 'khabrein dekh', weather: 'mausam dekh',
  currency_convert: 'rate dekh', software_version: 'latest version dekh', read_file: 'file padh', search_text: 'code mein dhoondh',
  find_files: 'files dhoondh', directory_tree: 'project dekh', list_directory: 'folder dekh', edit_file: 'code badal',
  multi_edit: 'code badal', write_file: 'file likh', run_command: 'command chala', check_problems: 'errors check kar',
  git_info: 'git dekh', git_commit: 'commit kar', github: 'GitHub dekh', open_application: 'app khol', open_url: 'link khol',
  browser: 'browser mein kaam kar', system_info: 'Mac check kar', screen_time: 'screen time dekh', explore: 'code samajh',
};

/**
 * A short spoken update during a long job, so the user is not left in silence:
 * "Abhi mausam dekh raha hoon." or, for a team member, "Yatra abhi mausam dekh rahi hai."
 * `label` is the activity label ("Yatra: Getting the weather…" for a member's step).
 */
export function progressLineFor(toolId: string, label: string, gender: 'male' | 'female'): string {
  const doing = DOING[toolId] ?? 'kaam kar';
  const member = /^(\w+): /u.exec(label)?.[1];
  if (member && isTeamMemberId(member.toLowerCase())) {
    const memberGender = TEAM_GENDER[member.toLowerCase()] ?? 'male';
    return `${member} abhi ${doing} ${memberGender === 'female' ? 'rahi' : 'raha'} hai.`;
  }
  return `Abhi ${doing} ${gender === 'female' ? 'rahi' : 'raha'} hoon.`;
}

/** The team members' grammatical gender, for "Yatra … rahi hai". */
const TEAM_GENDER: Readonly<Record<string, 'male' | 'female'>> = { khoj: 'male', yatra: 'female', kavach: 'male', lipi: 'female' };
