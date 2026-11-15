import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { cpus, freemem, totalmem, uptime } from 'node:os';
import type { ActionToolPorts } from './action-tools.ts';
import { ToolFailure, type Tool, type ToolArgumentSchema, type ToolRegistry } from './contracts.ts';

/**
 * Small everyday tools: the clock, a calculator, unit and date maths, this
 * Mac's status (all local, no approval), and weather, exchange rates, and
 * software versions from public APIs meant for programs (after approval,
 * like every other web request).
 */

type Args = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Models often send null for optional arguments and numbers as strings. */
function clean(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== ''));
}

/** A tool whose arguments are checked by one function returning an error message, or undefined when valid. */
function simpleTool<Input extends Args>(
  definition: { id: string; effect: 'read' | 'network'; description: string; parameters: ToolArgumentSchema },
  check: (input: Record<string, unknown>) => string | undefined,
  run: (input: Input, signal: AbortSignal) => Promise<Record<string, unknown>>,
): Tool<Input, Record<string, unknown>> {
  const allowed = new Set(Object.keys(definition.parameters.properties));
  const error = (value: unknown): string | undefined => {
    if (!isRecord(value)) return 'Arguments must be a JSON object.';
    const unknown = Object.keys(value).find(key => !allowed.has(key));
    if (unknown) return `Unknown argument "${unknown}". Use only: ${[...allowed].join(', ')}.`;
    for (const key of definition.parameters.required ?? []) {
      if (value[key] === undefined) return `${key} is required.`;
    }
    return check(value);
  };
  return {
    ...definition,
    normalizeInput: clean,
    validateInput: (value): value is Input => error(value) === undefined,
    inputError: error,
    validateOutput: (value): value is Record<string, unknown> => isRecord(value),
    run,
  };
}

const text = (value: unknown, max: number): boolean => typeof value === 'string' && value.trim() !== '' && value.length <= max;
const optionalText = (value: unknown, max: number): boolean => value === undefined || text(value, max);

// ── Time ───────────────────────────────────────────────────────────────────

/** Common places people name instead of an IANA time zone. */
const CITY_ZONES: Readonly<Record<string, string>> = {
  india: 'Asia/Kolkata', ist: 'Asia/Kolkata', delhi: 'Asia/Kolkata', 'new delhi': 'Asia/Kolkata', mumbai: 'Asia/Kolkata',
  bangalore: 'Asia/Kolkata', bengaluru: 'Asia/Kolkata', kolkata: 'Asia/Kolkata', chennai: 'Asia/Kolkata', hyderabad: 'Asia/Kolkata',
  pune: 'Asia/Kolkata', patna: 'Asia/Kolkata', utc: 'UTC', gmt: 'UTC',
  london: 'Europe/London', uk: 'Europe/London', paris: 'Europe/Paris', berlin: 'Europe/Berlin', germany: 'Europe/Berlin',
  amsterdam: 'Europe/Amsterdam', madrid: 'Europe/Madrid', rome: 'Europe/Rome', moscow: 'Europe/Moscow', istanbul: 'Europe/Istanbul',
  dubai: 'Asia/Dubai', uae: 'Asia/Dubai', riyadh: 'Asia/Riyadh', karachi: 'Asia/Karachi', pakistan: 'Asia/Karachi',
  dhaka: 'Asia/Dhaka', bangladesh: 'Asia/Dhaka', kathmandu: 'Asia/Kathmandu', nepal: 'Asia/Kathmandu', colombo: 'Asia/Colombo',
  singapore: 'Asia/Singapore', bangkok: 'Asia/Bangkok', jakarta: 'Asia/Jakarta', 'hong kong': 'Asia/Hong_Kong',
  shanghai: 'Asia/Shanghai', beijing: 'Asia/Shanghai', china: 'Asia/Shanghai', tokyo: 'Asia/Tokyo', japan: 'Asia/Tokyo',
  seoul: 'Asia/Seoul', korea: 'Asia/Seoul', sydney: 'Australia/Sydney', melbourne: 'Australia/Melbourne', auckland: 'Pacific/Auckland',
  'new york': 'America/New_York', nyc: 'America/New_York', boston: 'America/New_York', toronto: 'America/Toronto',
  chicago: 'America/Chicago', texas: 'America/Chicago', dallas: 'America/Chicago', denver: 'America/Denver',
  'los angeles': 'America/Los_Angeles', la: 'America/Los_Angeles', 'san francisco': 'America/Los_Angeles',
  seattle: 'America/Los_Angeles', california: 'America/Los_Angeles', vancouver: 'America/Vancouver',
  'mexico city': 'America/Mexico_City', 'sao paulo': 'America/Sao_Paulo', brazil: 'America/Sao_Paulo',
  'buenos aires': 'America/Argentina/Buenos_Aires', johannesburg: 'Africa/Johannesburg', nairobi: 'Africa/Nairobi',
  cairo: 'Africa/Cairo', lagos: 'Africa/Lagos',
};

export function resolveTimeZone(name: string): string | undefined {
  const key = name.trim().toLowerCase();
  const zone = CITY_ZONES[key] ?? name.trim();
  try {
    // Validate only: ICU may report an older alias (Asia/Calcutta for Asia/Kolkata).
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return CITY_ZONES[key] ?? (Intl.supportedValuesOf('timeZone').find(item => item.toLowerCase() === key) ?? zone);
  } catch {
    return undefined;
  }
}

export function describeTime(at: Date, timeZone?: string): Record<string, string> {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const part = (options: Intl.DateTimeFormatOptions): string => new Intl.DateTimeFormat('en-GB', { timeZone: zone, ...options }).format(at);
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(at).find(item => item.type === 'timeZoneName')?.value ?? '';
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  return {
    timeZone: zone,
    utcOffset: offset.replace('GMT', 'UTC') || 'UTC',
    date: ymd,
    weekday: part({ weekday: 'long' }),
    time: part({ hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase(),
    time24: part({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
    readable: part({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
  };
}

// ── Calculator ─────────────────────────────────────────────────────────────

const FUNCTIONS: Readonly<Record<string, (...values: number[]) => number>> = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  ln: Math.log, log: Math.log10, log10: Math.log10, log2: Math.log2, exp: Math.exp,
  sin: value => Math.sin(value * Math.PI / 180), cos: value => Math.cos(value * Math.PI / 180), tan: value => Math.tan(value * Math.PI / 180),
  min: Math.min, max: Math.max, pow: Math.pow,
};
const CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, e: Math.E };

/**
 * Evaluates arithmetic without eval: + - * / ^, "mod", parentheses, postfix
 * % (percent) and ! (factorial), functions (degrees for trig), pi and e, and
 * phrases like "15% of 2400". Thousands separators are allowed.
 */
export function evaluateExpression(source: string): number {
  const prepared = source
    .toLowerCase()
    .replace(/×/gu, '*')
    .replace(/(?<=[\d)]\s*)x(?=\s*[\d(.])/gu, '*')
    .replace(/÷/gu, '/')
    .replace(/(\d),(?=\d{2,3}\b)/gu, '$1')
    .replace(/(\d+(?:\.\d+)?)\s*%\s*of\b/gu, '($1/100)*');
  const tokens = prepared.match(/\d+(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+|[a-z_][a-z0-9_]*|\*\*|[-+*/^%!(),]/gu) ?? [];
  if (tokens.join('').replace(/\s/gu, '') !== prepared.replace(/\s/gu, '')) {
    throw new ToolFailure('The expression has characters a calculator cannot read. Use numbers, + - * / ^, %, parentheses, and functions like sqrt().', 'unsupported-operation');
  }
  let index = 0;
  const peek = (): string | undefined => tokens[index];
  const take = (expected?: string): string => {
    const token = tokens[index];
    if (token === undefined || (expected !== undefined && token !== expected)) {
      throw new ToolFailure(`The expression is incomplete near "${token ?? 'the end'}".`, 'unsupported-operation');
    }
    index += 1;
    return token;
  };
  const expression = (): number => {
    let value = term();
    while (peek() === '+' || peek() === '-') value = take() === '+' ? value + term() : value - term();
    return value;
  };
  const term = (): number => {
    let value = power();
    while (peek() === '*' || peek() === '/' || peek() === 'mod') {
      const operator = take();
      const right = power();
      value = operator === '*' ? value * right : operator === '/' ? value / right : value % right;
    }
    return value;
  };
  const power = (): number => {
    const base = unary();
    if (peek() === '^' || peek() === '**') {
      take();
      return base ** power();
    }
    return base;
  };
  const unary = (): number => {
    if (peek() === '-') { take(); return -unary(); }
    if (peek() === '+') { take(); return unary(); }
    return postfix();
  };
  const postfix = (): number => {
    let value = primary();
    while (peek() === '%' || peek() === '!') {
      if (take() === '%') value /= 100;
      else {
        if (!Number.isInteger(value) || value < 0 || value > 170) throw new ToolFailure('Factorial needs a whole number from 0 to 170.', 'unsupported-operation');
        let product = 1;
        for (let factor = 2; factor <= value; factor += 1) product *= factor;
        value = product;
      }
    }
    return value;
  };
  const primary = (): number => {
    const token = take();
    if (token === '(') {
      const value = expression();
      take(')');
      return value;
    }
    if (/^(?:\d|\.)/u.test(token)) return Number(token);
    if (Object.hasOwn(CONSTANTS, token)) return CONSTANTS[token] as number;
    const fn = FUNCTIONS[token];
    if (fn) {
      take('(');
      const values = [expression()];
      while (peek() === ',') { take(); values.push(expression()); }
      take(')');
      return fn(...values);
    }
    throw new ToolFailure(`Unknown name "${token}" in the expression.`, 'unsupported-operation');
  };
  const result = expression();
  if (index < tokens.length) throw new ToolFailure(`Unexpected "${tokens[index]}" in the expression.`, 'unsupported-operation');
  if (!Number.isFinite(result)) throw new ToolFailure('The result is not a finite number (for example, division by zero).', 'unsupported-operation');
  return result;
}

function tidy(value: number): number {
  return Number.parseFloat(value.toPrecision(12));
}

// ── Units ──────────────────────────────────────────────────────────────────

interface Unit { readonly kind: string; readonly factor: number; readonly name: string }

const UNIT_TABLE: readonly [kind: string, factor: number, name: string, aliases: string][] = [
  ['length', 1, 'm', 'm meter meters metre metres'],
  ['length', 1_000, 'km', 'km kilometer kilometers kilometre kilometres'],
  ['length', 0.01, 'cm', 'cm centimeter centimeters centimetre centimetres'],
  ['length', 0.001, 'mm', 'mm millimeter millimeters millimetre millimetres'],
  ['length', 1_609.344, 'mi', 'mi mile miles'],
  ['length', 0.9144, 'yd', 'yd yard yards'],
  ['length', 0.3048, 'ft', 'ft foot feet'],
  ['length', 0.0254, 'in', 'in inch inches'],
  ['length', 1_852, 'nmi', 'nmi nautical_mile nautical_miles'],
  ['mass', 1, 'kg', 'kg kilogram kilograms kilo kilos'],
  ['mass', 0.001, 'g', 'g gram grams gm'],
  ['mass', 0.000_001, 'mg', 'mg milligram milligrams'],
  ['mass', 1_000, 't', 't tonne tonnes ton tons metric_ton'],
  ['mass', 100, 'quintal', 'quintal quintals'],
  ['mass', 0.453_592_37, 'lb', 'lb lbs pound pounds'],
  ['mass', 0.028_349_523_125, 'oz', 'oz ounce ounces'],
  ['mass', 6.350_293_18, 'st', 'st stone stones'],
  ['volume', 1, 'L', 'l liter liters litre litres'],
  ['volume', 0.001, 'mL', 'ml milliliter milliliters millilitre millilitres'],
  ['volume', 1_000, 'm³', 'm3 cubic_meter cubic_meters'],
  ['volume', 3.785_411_784, 'gal', 'gal gallon gallons us_gallon'],
  ['volume', 0.236_588_236_5, 'cup', 'cup cups'],
  ['volume', 0.029_573_529_6, 'fl oz', 'floz fl_oz fluid_ounce fluid_ounces'],
  ['area', 1, 'm²', 'm2 sqm sq_m square_meter square_meters'],
  ['area', 1_000_000, 'km²', 'km2 sqkm sq_km square_kilometer square_kilometers'],
  ['area', 0.092_903_04, 'ft²', 'ft2 sqft sq_ft square_foot square_feet'],
  ['area', 4_046.856_422_4, 'acre', 'acre acres'],
  ['area', 10_000, 'ha', 'ha hectare hectares'],
  ['speed', 1, 'm/s', 'm/s mps meters_per_second'],
  ['speed', 1_000 / 3_600, 'km/h', 'km/h kmh kmph kph'],
  ['speed', 1_609.344 / 3_600, 'mph', 'mph miles_per_hour'],
  ['speed', 1_852 / 3_600, 'kn', 'kn knot knots'],
  ['data', 1, 'B', 'b byte bytes'],
  ['data', 1e3, 'KB', 'kb kilobyte kilobytes'],
  ['data', 1e6, 'MB', 'mb megabyte megabytes'],
  ['data', 1e9, 'GB', 'gb gigabyte gigabytes'],
  ['data', 1e12, 'TB', 'tb terabyte terabytes'],
  ['data', 1_024, 'KiB', 'kib'],
  ['data', 1_048_576, 'MiB', 'mib'],
  ['data', 1_073_741_824, 'GiB', 'gib'],
  ['time', 1, 's', 's sec secs second seconds'],
  ['time', 0.001, 'ms', 'ms millisecond milliseconds'],
  ['time', 60, 'min', 'min mins minute minutes'],
  ['time', 3_600, 'h', 'h hr hrs hour hours'],
  ['time', 86_400, 'day', 'd day days'],
  ['time', 604_800, 'week', 'wk week weeks'],
  ['time', 31_557_600, 'year', 'yr year years'],
];
const UNITS = new Map<string, Unit>();
for (const [kind, factor, name, aliases] of UNIT_TABLE) {
  for (const alias of aliases.split(' ')) UNITS.set(alias, { kind, factor, name });
}
const TEMPERATURES: Readonly<Record<string, string>> = {
  c: 'C', celsius: 'C', centigrade: 'C', '°c': 'C', f: 'F', fahrenheit: 'F', '°f': 'F', k: 'K', kelvin: 'K',
};

export function convertUnits(value: number, from: string, to: string): { value: number; from: string; to: string } {
  const key = (unit: string): string => unit.trim().toLowerCase().replace(/\s+/gu, '_').replace(/^square_/u, 'square_').replace(/²/gu, '2').replace(/³/gu, '3');
  const fromTemp = TEMPERATURES[key(from)];
  const toTemp = TEMPERATURES[key(to)];
  if (fromTemp && toTemp) {
    const celsius = fromTemp === 'C' ? value : fromTemp === 'F' ? (value - 32) * 5 / 9 : value - 273.15;
    const result = toTemp === 'C' ? celsius : toTemp === 'F' ? celsius * 9 / 5 + 32 : celsius + 273.15;
    return { value: tidy(result), from: `°${fromTemp}`.replace('°K', 'K'), to: `°${toTemp}`.replace('°K', 'K') };
  }
  const source = UNITS.get(key(from));
  const target = UNITS.get(key(to));
  if (!source || !target) {
    throw new ToolFailure(`Unknown unit "${!source ? from : to}". Supported: length, mass, volume, area, speed, data size, time, and temperature (C, F, K).`, 'unsupported-operation');
  }
  if (source.kind !== target.kind) {
    throw new ToolFailure(`Cannot convert ${source.kind} (${source.name}) to ${target.kind} (${target.name}).`, 'unsupported-operation');
  }
  return { value: tidy(value * source.factor / target.factor), from: source.name, to: target.name };
}

// ── Dates ──────────────────────────────────────────────────────────────────

function parseDay(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value.trim());
  const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : undefined;
  if (!date || Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(match?.[3])) {
    throw new ToolFailure(`"${value}" is not a date in YYYY-MM-DD form.`, 'unsupported-operation');
  }
  return date;
}

function today(timeZone?: string): Date {
  return parseDay(describeTime(new Date(), timeZone).date as string);
}

const dayString = (date: Date): string => date.toISOString().slice(0, 10);
const weekdayOf = (date: Date): string => new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(date);

export function dateMath(input: { date?: string; other_date?: string; add?: string }, now: Date = today()): Record<string, unknown> {
  const start = input.date ? parseDay(input.date) : now;
  if (input.other_date) {
    const end = parseDay(input.other_date);
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
    const [earlier, later] = days >= 0 ? [start, end] : [end, start];
    let months = (later.getUTCFullYear() - earlier.getUTCFullYear()) * 12 + later.getUTCMonth() - earlier.getUTCMonth();
    if (later.getUTCDate() < earlier.getUTCDate()) months -= 1;
    return {
      from: `${dayString(start)} (${weekdayOf(start)})`,
      to: `${dayString(end)} (${weekdayOf(end)})`,
      days,
      weeks: tidy(days / 7),
      yearsAndMonths: `${Math.floor(months / 12)} years ${months % 12} months`,
    };
  }
  const match = /^([+-]?\d+)\s*(day|days|d|week|weeks|w|month|months|m|year|years|y)$/iu.exec((input.add ?? '').trim());
  if (!match) throw new ToolFailure('Pass other_date (to count days between dates) or add, like "+45 days", "-2 weeks", "3 months".', 'unsupported-operation');
  const amount = Number(match[1]);
  const unit = (match[2] as string).toLowerCase()[0];
  const result = new Date(start);
  if (unit === 'd') result.setUTCDate(result.getUTCDate() + amount);
  else if (unit === 'w') result.setUTCDate(result.getUTCDate() + amount * 7);
  else if (unit === 'm') result.setUTCMonth(result.getUTCMonth() + amount);
  else result.setUTCFullYear(result.getUTCFullYear() + amount);
  return { from: `${dayString(start)} (${weekdayOf(start)})`, add: match[0], result: `${dayString(result)} (${weekdayOf(result)})` };
}

// ── This Mac ───────────────────────────────────────────────────────────────

function runQuietly(file: string, args: readonly string[]): Promise<string> {
  return new Promise(resolve => {
    execFile(file, args, { timeout: 5_000 }, (error, stdout) => resolve(error ? '' : String(stdout).trim()));
  });
}

const gigabytes = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

async function systemInfo(): Promise<Record<string, unknown>> {
  const [macOS, model, battery, disk] = await Promise.all([
    runQuietly('/usr/bin/sw_vers', ['-productVersion']),
    runQuietly('/usr/sbin/sysctl', ['-n', 'hw.model']),
    runQuietly('/usr/bin/pmset', ['-g', 'batt']),
    statfs('/').catch(() => undefined),
  ]);
  const charge = /(\d+)%;\s*([^;]+);\s*([^\n]*)/u.exec(battery);
  const seconds = uptime();
  return {
    macOS: macOS || 'unknown',
    model: model || 'unknown',
    chip: cpus()[0]?.model ?? 'unknown',
    cores: cpus().length,
    memory: { total: gigabytes(totalmem()), freeApprox: gigabytes(freemem()) },
    ...(disk ? { disk: { total: gigabytes(disk.blocks * disk.bsize), free: gigabytes(disk.bavail * disk.bsize) } } : {}),
    battery: charge
      ? { percent: Number(charge[1]), state: (charge[2] as string).trim(), remaining: (charge[3] as string).replace(/present: true/u, '').trim() || undefined }
      : battery.includes('AC Power') ? 'on AC power (no battery)' : 'unknown',
    uptime: `${Math.floor(seconds / 86_400)} days ${Math.floor(seconds % 86_400 / 3_600)} hours`,
  };
}

// ── Weather ────────────────────────────────────────────────────────────────

const WEATHER_CODES: Readonly<Record<number, string>> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'heavy freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers',
  82: 'violent showers', 85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm',
  96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
};

type FetchRaw = (url: string, signal: AbortSignal) => Promise<string>;

async function getJson(fetchRaw: FetchRaw, url: string, signal: AbortSignal): Promise<unknown> {
  const body = await fetchRaw(url, signal);
  try {
    return JSON.parse(body);
  } catch {
    throw new ToolFailure(`${new URL(url).hostname} did not answer with data.`, 'tool-failed');
  }
}

async function weather(fetchRaw: FetchRaw, place: string, days: number, signal: AbortSignal): Promise<Record<string, unknown>> {
  const geo = await getJson(fetchRaw, `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`, signal);
  const found = isRecord(geo) && Array.isArray(geo.results) && isRecord(geo.results[0]) ? geo.results[0] : undefined;
  if (!found || typeof found.latitude !== 'number' || typeof found.longitude !== 'number') {
    throw new ToolFailure(`No place called "${place}" was found. Try the city name in English.`, 'not-found');
  }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${found.latitude}&longitude=${found.longitude}`
    + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset'
    + `&timezone=auto&forecast_days=${days}`;
  const data = await getJson(fetchRaw, url, signal);
  if (!isRecord(data) || !isRecord(data.current) || !isRecord(data.daily)) throw new ToolFailure('The weather service answered without a forecast.', 'tool-failed');
  const current = data.current;
  const daily = data.daily as Record<string, unknown[]>;
  const forecast = (daily.time ?? []).map((day, index) => ({
    date: day,
    weather: WEATHER_CODES[Number(daily.weather_code?.[index])] ?? 'unknown',
    minC: daily.temperature_2m_min?.[index],
    maxC: daily.temperature_2m_max?.[index],
    rainChancePercent: daily.precipitation_probability_max?.[index],
    sunrise: String(daily.sunrise?.[index] ?? '').slice(11),
    sunset: String(daily.sunset?.[index] ?? '').slice(11),
  }));
  return {
    status: 'fetched',
    source: 'Open-Meteo',
    place: [found.name, found.admin1, found.country].filter(part => typeof part === 'string').join(', '),
    localTime: current.time,
    now: {
      weather: WEATHER_CODES[Number(current.weather_code)] ?? 'unknown',
      temperatureC: current.temperature_2m,
      feelsLikeC: current.apparent_temperature,
      humidityPercent: current.relative_humidity_2m,
      precipitationMm: current.precipitation,
      windKmh: current.wind_speed_10m,
    },
    forecast,
  };
}

// ── Exchange rates ─────────────────────────────────────────────────────────

async function exchange(fetchRaw: FetchRaw, amount: number, from: string, to: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const data = await getJson(fetchRaw, `https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`, signal).catch((error: unknown) => {
    if (error instanceof ToolFailure && /HTTP 404|HTTP 422/u.test(error.message)) {
      throw new ToolFailure(`Rates for ${from} or ${to} are not available. Supported: major currencies such as INR, USD, EUR, GBP, JPY, AUD, CAD, SGD, CNY (not crypto).`, 'not-found');
    }
    throw error;
  });
  const rate = isRecord(data) && isRecord(data.rates) ? data.rates[to] : undefined;
  if (typeof rate !== 'number') throw new ToolFailure(`No rate from ${from} to ${to} is available.`, 'not-found');
  return {
    status: 'fetched',
    source: 'European Central Bank reference rates (frankfurter.dev)',
    rateDate: isRecord(data) ? data.date : undefined,
    rate: `1 ${from} = ${rate} ${to}`,
    amount: `${amount} ${from}`,
    result: `${tidy(amount * rate)} ${to}`,
    note: 'Reference rates, published once a working day; banks and cards charge a margin on top.',
  };
}

// ── Software versions ──────────────────────────────────────────────────────

type Ecosystem = 'npm' | 'pypi' | 'github' | 'homebrew';
const REGISTRY_HOSTS: Readonly<Record<Ecosystem, string>> = {
  npm: 'registry.npmjs.org', pypi: 'pypi.org', github: 'api.github.com', homebrew: 'formulae.brew.sh',
};

async function softwareVersion(fetchRaw: FetchRaw, name: string, ecosystem: Ecosystem, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (ecosystem === 'github') {
    const repo = name.replace(/^https?:\/\/github\.com\//u, '').replace(/\/$/u, '');
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repo)) throw new ToolFailure('For GitHub, pass the repository as owner/name, e.g. facebook/react-native.', 'unsupported-operation');
    const releases = await getJson(fetchRaw, `https://api.github.com/repos/${repo}/releases?per_page=10`, signal);
    const latest = Array.isArray(releases) ? releases.find(item => isRecord(item) && !item.draft && !item.prerelease) : undefined;
    if (!isRecord(latest)) throw new ToolFailure(`${repo} has no published GitHub releases.`, 'not-found');
    return { status: 'fetched', source: 'GitHub releases', name: repo, version: latest.tag_name, released: String(latest.published_at ?? '').slice(0, 10), url: latest.html_url };
  }
  if (ecosystem === 'pypi') {
    const data = await getJson(fetchRaw, `https://pypi.org/pypi/${encodeURIComponent(name)}/json`, signal);
    const info = isRecord(data) && isRecord(data.info) ? data.info : undefined;
    if (!info) throw new ToolFailure(`PyPI has no package called "${name}".`, 'not-found');
    const files = isRecord(data) && Array.isArray(data.urls) ? data.urls : [];
    const uploaded = files.map(file => (isRecord(file) ? String(file.upload_time ?? '') : '')).sort()[0];
    return { status: 'fetched', source: 'PyPI', name: info.name, version: info.version, ...(uploaded ? { released: uploaded.slice(0, 10) } : {}), url: `https://pypi.org/project/${String(info.name)}/` };
  }
  if (ecosystem === 'homebrew') {
    const data = await getJson(fetchRaw, `https://formulae.brew.sh/api/formula/${encodeURIComponent(name)}.json`, signal);
    const versions = isRecord(data) && isRecord(data.versions) ? data.versions : undefined;
    if (!versions) throw new ToolFailure(`Homebrew has no formula called "${name}".`, 'not-found');
    return { status: 'fetched', source: 'Homebrew', name, version: versions.stable, url: `https://formulae.brew.sh/formula/${name}` };
  }
  // npm: exact package name first ("React Native" → react-native), then the registry's own search.
  const exact = name.trim().toLowerCase().replace(/\s+/gu, '-');
  const search = await getJson(fetchRaw, `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(exact)}&size=5`, signal);
  const packages = isRecord(search) && Array.isArray(search.objects)
    ? search.objects.map(item => (isRecord(item) && isRecord(item.package) ? item.package : undefined)).filter(isRecord)
    : [];
  const chosen = packages.find(item => item.name === exact) ?? packages[0];
  if (!chosen || typeof chosen.name !== 'string') throw new ToolFailure(`npm has no package matching "${name}".`, 'not-found');
  const latest = await getJson(fetchRaw, `https://registry.npmjs.org/${chosen.name.replace('/', '%2F')}/latest`, signal);
  return {
    status: 'fetched',
    source: 'npm registry',
    name: chosen.name,
    version: isRecord(latest) ? latest.version : chosen.version,
    ...(typeof chosen.date === 'string' ? { released: chosen.date.slice(0, 10) } : {}),
    url: `https://www.npmjs.com/package/${chosen.name}`,
    ...(chosen.name !== exact ? { note: `No package is named exactly "${exact}"; this is the closest match.` } : {}),
    ...(packages.length > 1 ? { otherMatches: packages.filter(item => item !== chosen).slice(0, 3).map(item => `${String(item.name)} ${String(item.version)}`) } : {}),
  };
}

// ── Registration ───────────────────────────────────────────────────────────

const CURRENCY = /^[A-Za-z]{3}$/u;
const ECOSYSTEMS = new Set(['npm', 'pypi', 'github', 'homebrew']);

function parseNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace(/,/gu, '').trim()) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

export function registerUtilityTools(registry: ToolRegistry, ports?: ActionToolPorts): void {
  registry.register(simpleTool<{ timezone?: string }>({
    id: 'current_time',
    effect: 'read',
    description: 'The exact current date, time, and weekday on this Mac, and optionally in another place or time zone (a city like "London" or an IANA zone like "America/New_York"). Use for any question about the time, today\'s date or day, or the time somewhere else. Never guess the time.',
    parameters: {
      type: 'object',
      properties: { timezone: { type: 'string', description: 'Optional city, country, or IANA time zone to also show.', maxLength: 64 } },
      additionalProperties: false,
    },
  }, input => (optionalText(input.timezone, 64) ? undefined : 'timezone must be a short place or zone name.'), async input => {
    const now = new Date();
    const result: Record<string, unknown> = { here: describeTime(now) };
    if (input.timezone) {
      const zone = resolveTimeZone(input.timezone);
      if (!zone) throw new ToolFailure(`Unknown place or time zone "${input.timezone}". Use an IANA zone like "Asia/Tokyo" or "Europe/Paris".`, 'not-found');
      result.there = { place: input.timezone, ...describeTime(now, zone) };
    }
    return result;
  }));

  registry.register(simpleTool<{ expression: string }>({
    id: 'calculate',
    effect: 'read',
    description: 'Exact arithmetic. Use it for every calculation instead of working it out yourself: + - * / ^, mod, parentheses, percent ("18% of 2499", "2499 * 1.18"), factorial (5!), sqrt, cbrt, abs, round, floor, ceil, log (base 10), ln, log2, exp, sin/cos/tan (degrees), min, max, pow, pi, e.',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'The expression, e.g. "(1200 + 350) * 12" or "15% of 84000".', maxLength: 300 } },
      required: ['expression'],
      additionalProperties: false,
    },
  }, input => (text(input.expression, 300) ? undefined : 'expression must be a short arithmetic expression.'), async input => {
    const result = tidy(evaluateExpression(input.expression));
    return { expression: input.expression, result, formatted: new Intl.NumberFormat('en-IN', { maximumFractionDigits: 10 }).format(result) };
  }));

  registry.register(simpleTool<{ value: string; from: string; to: string }>({
    id: 'convert_units',
    effect: 'read',
    description: 'Convert a measurement between units: length (km, mi, m, ft, in, cm…), mass (kg, g, lb, oz, quintal…), volume (L, mL, gal, cup…), area (sq ft, m2, acre, hectare…), speed (km/h, mph, m/s, knots), data (MB, GB, GiB…), time (min, h, days, weeks, years), and temperature (C, F, K). Not for currencies.',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'The number to convert, e.g. "5.5".', maxLength: 40 },
        from: { type: 'string', description: 'Unit to convert from, e.g. "km".', maxLength: 30 },
        to: { type: 'string', description: 'Unit to convert to, e.g. "mi".', maxLength: 30 },
      },
      required: ['value', 'from', 'to'],
      additionalProperties: false,
    },
  }, input => (parseNumber(input.value) === undefined ? 'value must be a number.' : !text(input.from, 30) || !text(input.to, 30) ? 'from and to must be unit names.' : undefined), async input => {
    const value = parseNumber(input.value) as number;
    const result = convertUnits(value, input.from, input.to);
    return { input: `${value} ${result.from}`, result: `${result.value} ${result.to}`, value: result.value };
  }));

  registry.register(simpleTool<{ date?: string; other_date?: string; add?: string }>({
    id: 'date_math',
    effect: 'read',
    description: 'Date arithmetic on the calendar. Count the days between two dates (pass other_date: "how many days until 2027-01-01", age, deadlines), or add/subtract a period (pass add: "+45 days", "-2 weeks", "3 months"). date defaults to today. Dates are YYYY-MM-DD.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Start date YYYY-MM-DD (default: today).', maxLength: 10 },
        other_date: { type: 'string', description: 'Second date YYYY-MM-DD, to count the days between.', maxLength: 10 },
        add: { type: 'string', description: 'Period to add, e.g. "+45 days", "-2 weeks", "3 months", "1 year".', maxLength: 20 },
      },
      additionalProperties: false,
    },
  }, input => {
    if (!optionalText(input.date, 10) || !optionalText(input.other_date, 10) || !optionalText(input.add, 20)) return 'Dates must be YYYY-MM-DD and add like "+45 days".';
    if ((input.other_date === undefined) === (input.add === undefined)) return 'Pass either other_date or add.';
    return undefined;
  }, async input => dateMath(input)));

  registry.register(simpleTool<Record<string, never>>({
    id: 'system_info',
    effect: 'read',
    description: 'This Mac\'s status: macOS version, model, chip, memory, free disk space, battery level and charging state, and uptime. Use for "battery kitna hai", "disk space", "which macOS".',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  }, () => undefined, systemInfo));

  const approval = ports?.approval;
  const fetchRaw = ports?.web?.fetchRaw?.bind(ports.web);
  if (!approval || !fetchRaw) return;
  const memory = ports.approvalMemory;
  const approve = async (target: string, host: string, signal: AbortSignal): Promise<boolean> => {
    if (memory?.hasHost(host)) return true;
    const decision = await approval.request({ kind: 'web', operation: 'fetch', target, host }, signal);
    if (decision === 'always') memory?.allowHost(host);
    return decision !== false;
  };

  registry.register(simpleTool<{ place: string; days?: number }>({
    id: 'weather',
    effect: 'network',
    description: 'Current weather and a daily forecast (up to 7 days) for a place, from Open-Meteo (after approval): conditions, temperature, feels-like, humidity, rain chance, wind, sunrise and sunset. Use for "mausam kaisa hai", "will it rain tomorrow in Pune".',
    parameters: {
      type: 'object',
      properties: {
        place: { type: 'string', description: 'City or town, in English, e.g. "Patna".', maxLength: 80 },
        days: { type: 'integer', description: 'Forecast days, 1-7 (default 3).', minimum: 1, maximum: 7 },
      },
      required: ['place'],
      additionalProperties: false,
    },
  }, input => {
    if (!text(input.place, 80)) return 'place must be a city name.';
    if (input.days !== undefined && (!Number.isInteger(input.days) || (input.days as number) < 1 || (input.days as number) > 7)) return 'days must be 1-7.';
    return undefined;
  }, async (input, signal) => {
    if (!await approve(input.place, 'open-meteo.com', signal)) return { status: 'rejected', place: input.place };
    return weather(fetchRaw, input.place.trim(), input.days ?? 3, signal);
  }));

  registry.register(simpleTool<{ amount: string; from: string; to: string }>({
    id: 'currency_convert',
    effect: 'network',
    description: 'Convert money between currencies at today\'s reference rate (European Central Bank, after approval). Use ISO codes; major currencies are covered (INR, USD, EUR, GBP, JPY, AUD, CAD, SGD, CNY, CHF…), but not AED or crypto. Use for "100 dollar kitne rupaye", exchange rates.',
    parameters: {
      type: 'object',
      properties: {
        amount: { type: 'string', description: 'Amount, e.g. "100".', maxLength: 30 },
        from: { type: 'string', description: 'Three-letter currency code, e.g. "USD".', maxLength: 3 },
        to: { type: 'string', description: 'Three-letter currency code, e.g. "INR".', maxLength: 3 },
      },
      required: ['amount', 'from', 'to'],
      additionalProperties: false,
    },
  }, input => {
    if (parseNumber(input.amount) === undefined) return 'amount must be a number.';
    if (typeof input.from !== 'string' || typeof input.to !== 'string' || !CURRENCY.test(input.from) || !CURRENCY.test(input.to)) return 'from and to must be three-letter currency codes like USD and INR.';
    return undefined;
  }, async (input, signal) => {
    const from = input.from.toUpperCase();
    const to = input.to.toUpperCase();
    if (!await approve(`${from} → ${to}`, 'frankfurter.dev', signal)) return { status: 'rejected' };
    if (from === to) return { status: 'fetched', result: `${parseNumber(input.amount)} ${to}` };
    return exchange(fetchRaw, parseNumber(input.amount) as number, from, to, signal);
  }));

  registry.register(simpleTool<{ name: string; ecosystem?: string }>({
    id: 'software_version',
    effect: 'network',
    description: 'The latest released version of a library, framework, or tool, straight from its official registry (after approval): npm (JavaScript: react, react-native, next, typescript…), pypi (Python: django, numpy…), homebrew (Mac tools: node, git, python…), or github (owner/repo releases). Use for any "latest version of X" question instead of web_search or memory.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Package name ("react-native", "django"), or owner/repo for github.', maxLength: 120 },
        ecosystem: { type: 'string', description: '"npm" (default), "pypi", "homebrew", or "github".', maxLength: 10 },
      },
      required: ['name'],
      additionalProperties: false,
    },
  }, input => {
    if (!text(input.name, 120)) return 'name must be a package name.';
    if (input.ecosystem !== undefined && (typeof input.ecosystem !== 'string' || !ECOSYSTEMS.has(input.ecosystem.toLowerCase()))) return 'ecosystem must be npm, pypi, homebrew, or github.';
    return undefined;
  }, async (input, signal) => {
    const ecosystem = (input.ecosystem?.toLowerCase() ?? 'npm') as Ecosystem;
    if (!await approve(`${input.name} (${ecosystem})`, REGISTRY_HOSTS[ecosystem], signal)) return { status: 'rejected' };
    return softwareVersion(fetchRaw, input.name.trim(), ecosystem, signal);
  }));
}
