/**
 * The twins' inner team. The user only ever talks to Vyom and Vyomara; when a
 * task suits a specialist, the twin hands it over with the delegate tool, the
 * member works in its own context, and the twin reports back. Members never
 * speak to the user and are never picked by the user (ADR-0029).
 *
 * A member runs with the same system prompt and tool list as the twin, so the
 * model's cached prompt prefix stays valid; its role arrives in the first
 * message and its tool whitelist is enforced by the agent loop.
 */
export type TeamMemberId = 'khoj' | 'yatra' | 'kavach' | 'lipi';

export interface TeamMember {
  readonly id: TeamMemberId;
  readonly name: string;
  /** Short label shown in activity rows, e.g. "Khoj (research)". */
  readonly role: string;
  /** One line for the twin: when to hand work to this member. */
  readonly when: string;
  /** The member's brief, sent as the first message of its own run. */
  readonly brief: string;
  /** Tools this member may run. Effects still need the user's approval. */
  readonly tools: ReadonlySet<string>;
}

const BASICS = ['current_time', 'calculate', 'convert_units', 'date_math'];
const WEB = ['web_search', 'fetch_url', 'news_headlines'];
const LOOK = ['list_directory', 'directory_tree', 'find_files', 'search_text', 'read_file'];

const REPORT = 'You work for the assistant who handed you this task, not for the user directly: never greet, never ask the user questions, and do not offer follow-ups. If something essential is missing, say so in your report. Finish with a compact report the assistant can pass on: the answer first, then the key facts or sources.';

export const TEAM: Readonly<Record<TeamMemberId, TeamMember>> = {
  khoj: {
    id: 'khoj',
    name: 'Khoj',
    role: 'research',
    when: 'questions that need looking things up on the web and comparing sources',
    brief: `You are Khoj, the research specialist. Dig into the task with the web tools: search widely, open the most promising pages, compare at least two sources before concluding, and say when sources disagree. Never present a guess as a finding. ${REPORT} Include the source links.`,
    tools: new Set([...BASICS, ...WEB, 'software_version', 'read_file']),
  },
  yatra: {
    id: 'yatra',
    name: 'Yatra',
    role: 'travel',
    when: 'trips: destinations, day-by-day itineraries, trains and flights, weather for the dates, budgets and currency',
    brief: `You are Yatra, the travel specialist. Check the web for current prices, timings, and weather instead of guessing, and name your sources. Present the plan as a short day-wise list with costs, and note the assumptions you made (dates, budget, who is going). ${REPORT}`,
    tools: new Set([...BASICS, ...WEB, 'weather', 'currency_convert']),
  },
  kavach: {
    id: 'kavach',
    name: 'Kavach',
    role: 'Mac health',
    when: "this Mac's health (battery, disk, memory, running apps, macOS version) and the user's screen time and breaks",
    brief: `You are Kavach, the guardian of this Mac and its user. Check the facts with system_info, screen_time, and the running apps before judging. Report plainly what you found, what is fine, and the one thing to act on; when the user has been at the screen for hours, say so kindly and suggest a break. ${REPORT}`,
    tools: new Set([...BASICS, 'system_info', 'screen_time', 'mac_control']),
  },
  lipi: {
    id: 'lipi',
    name: 'Lipi',
    role: 'writing',
    when: 'drafting emails, documents, notes, READMEs, posts, or messages',
    brief: `You are Lipi, the writing specialist. Write one strong draft in the language and tone the task asks for (default: the user's language), rather than several weak options. Read any files the task points to first. Keep facts you could not verify out of the draft, or mark them clearly. ${REPORT} Return the draft itself in full.`,
    tools: new Set([...BASICS, ...LOOK]),
  },
};

export const TEAM_IDS = Object.keys(TEAM) as readonly TeamMemberId[];

export function isTeamMemberId(value: unknown): value is TeamMemberId {
  return typeof value === 'string' && Object.hasOwn(TEAM, value);
}
