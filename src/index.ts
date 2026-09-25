interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Runtime helpers for packs that wrap government open-data platforms.
 *
 * Socrata (SODA), CKAN, and ArcGIS FeatureServer/MapServer between them back a large share
 * of US state and municipal data, and every pack over them re-implements the same fetch,
 * timeout, retry, and shaping code. These helpers are deliberately small and dependency-free
 * so `scripts/publish-pack.sh` can inline them into a standalone published pack.
 *
 * State agency servers are slow and occasionally hostile: expect stalls, WAF interstitials
 * served with a 200 or 403, and columns whose names disagree between two datasets on the same
 * portal. `govFetchJson` therefore retries once by default and raises a message the caller can
 * turn into a `{ found: false, reason, hint }` rather than a bare throw.
 */

const DEFAULT_UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';
const DEFAULT_TIMEOUT_MS = 15_000;

interface GovFetchOpts {
  /** Sent as Accept; defaults to application/json. */
  accept?: string;
  /** Socrata app token, sent as X-App-Token. Public endpoints work without one. */
  appToken?: string;
  /** Per-attempt budget. State ArcGIS servers routinely need >12s under load. */
  timeoutMs?: number;
  /** Extra attempts after the first. Defaults to 1. */
  retries?: number;
  userAgent?: string;
}

async function govFetchText(url: string, opts: GovFetchOpts = {}): Promise<string> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': opts.userAgent ?? DEFAULT_UA,
        Accept: opts.accept ?? 'application/json',
      };
      if (opts.appToken) headers['X-App-Token'] = opts.appToken;
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`upstream ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function govFetchJson<T = unknown>(url: string, opts: GovFetchOpts = {}): Promise<T> {
  const text = await govFetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    // A WAF interstitial arrives as HTML on the JSON path; say so plainly, because the
    // alternative reads to a caller as our own parsing bug.
    const looksLikeChallenge = /<html|just a moment|captcha/i.test(text.slice(0, 400));
    throw new Error(
      looksLikeChallenge
        ? `upstream returned an HTML challenge page instead of JSON (${text.slice(0, 90).replace(/\s+/g, ' ')})`
        : `upstream returned non-JSON (${text.slice(0, 120)})`,
    );
  }
}

// ── Socrata (SODA 2.x) ──────────────────────────────────────────────

interface SoqlQuery {
  select?: string;
  where?: string;
  group?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

/** Escape a value for interpolation into a SoQL string literal. */
function soqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

function soqlUrl(domain: string, resource: string, q: SoqlQuery): string {
  const p = new URLSearchParams();
  if (q.select) p.set('$select', q.select);
  if (q.where) p.set('$where', q.where);
  if (q.group) p.set('$group', q.group);
  if (q.order) p.set('$order', q.order);
  p.set('$limit', String(q.limit ?? 1000));
  if (q.offset) p.set('$offset', String(q.offset));
  return `https://${domain}/resource/${resource}.json?${p.toString()}`;
}

async function soqlRows<T = Record<string, string>>(
  domain: string,
  resource: string,
  q: SoqlQuery,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  return govFetchJson<T[]>(soqlUrl(domain, resource, q), opts);
}

/**
 * A Socrata dataset's last row update, as YYYY-MM-DD, for an `as_of` field. Best-effort:
 * resolves to null rather than failing a call that otherwise has data.
 */
async function soqlUpdatedAt(
  domain: string,
  resource: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const meta = await govFetchJson<{ rowsUpdatedAt?: number }>(
      `https://${domain}/api/views/${resource}.json`,
      { ...opts, retries: 0 },
    );
    return meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Largest value of a column, e.g. the latest `year_month` a dataset carries. */
async function soqlMax(
  domain: string,
  resource: string,
  column: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const rows = await soqlRows<Record<string, string>>(
      domain,
      resource,
      { select: `max(${column}) as mx` },
      opts,
    );
    return rows[0]?.mx ?? null;
  } catch {
    return null;
  }
}

// ── CKAN ────────────────────────────────────────────────────────────

/** CKAN's read-only SQL endpoint (datastore_search_sql). */
async function ckanSql<T = Record<string, string>>(
  domain: string,
  sql: string,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{
    success?: boolean;
    result?: { records?: T[] };
    error?: unknown;
  }>(`https://${domain}/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`, opts);
  if (!body.success || !body.result?.records) {
    throw new Error(`CKAN rejected the query: ${JSON.stringify(body.error ?? {}).slice(0, 200)}`);
  }
  return body.result.records;
}

async function ckanRows<T = Record<string, unknown>>(
  domain: string,
  resourceId: string,
  limit: number,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{ result?: { records?: T[] } }>(
    `https://${domain}/api/3/action/datastore_search?resource_id=${resourceId}&limit=${limit}`,
    opts,
  );
  return body.result?.records ?? [];
}

// ── ArcGIS (FeatureServer / MapServer) ──────────────────────────────

interface ArcgisFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

interface ArcgisQueryOpts extends GovFetchOpts {
  where?: string;
  outFields?: string;
  orderBy?: string;
  limit?: number;
  /** Request geometry in WGS84. Many layers store State Plane, so read lat/lng from here
   *  rather than from XCOORD/YCOORD attribute columns. */
  geometry?: boolean;
  distinct?: boolean;
}

async function arcgisQuery(layerUrl: string, o: ArcgisQueryOpts = {}): Promise<ArcgisFeature[]> {
  const p = new URLSearchParams({
    where: o.where ?? '1=1',
    outFields: o.outFields ?? '*',
    returnGeometry: o.geometry ? 'true' : 'false',
    f: 'json',
  });
  if (o.geometry) p.set('outSR', '4326');
  if (o.orderBy) p.set('orderByFields', o.orderBy);
  if (o.limit) p.set('resultRecordCount', String(o.limit));
  if (o.distinct) p.set('returnDistinctValues', 'true');
  const body = await govFetchJson<{ features?: ArcgisFeature[]; error?: { message?: string } }>(
    `${layerUrl}/query?${p.toString()}`,
    o,
  );
  if (body.error) throw new Error(`ArcGIS: ${body.error.message ?? 'query rejected'}`);
  return body.features ?? [];
}

/** Turn "Y"/"Yes"/"true" flag columns into a list of human-readable service labels. */
function arcgisFlagLabels(
  attrs: Record<string, unknown>,
  labelByField: Record<string, string>,
): string[] {
  return Object.entries(labelByField)
    .filter(([field]) => /^(y|yes|true)$/i.test(String(attrs[field] ?? '')))
    .map(([, label]) => label);
}

// ── Small shaping utilities ─────────────────────────────────────────

/** A recoverable "no answer" result. The hint should name something that does work. */
function govNotFound(
  reason: string,
  hint: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { found: false, reason, hint, ...extra };
}

function govNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  // Parse as-is first. Socrata returns an all-zero aggregate as "0E-24", and stripping
  // non-numeric characters turns that into "0-24" → NaN, i.e. a real zero reported as
  // unknown. Number() understands scientific notation, so only fall back to stripping
  // for values carrying formatting (currency symbols, thousands separators).
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  // Require a digit before stripping: otherwise "abc" reduces to "" and Number("") is 0,
  // reporting a parse failure as a real zero.
  if (!/\d/.test(s)) return null;
  const stripped = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(stripped) ? stripped : null;
}

/** Trimmed string argument, or undefined when absent or blank. */
function govString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function govLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Case-insensitive substring test that tolerates a missing haystack. */
function govContains(hay: unknown, needle: string): boolean {
  return typeof hay === 'string' && hay.toLowerCase().includes(needle.toLowerCase());
}

/** Join day/hours pairs into one line, dropping closed and empty days. */
function govJoinHours(parts: Array<[string, unknown]>): string | null {
  const out = parts
    .filter(([, v]) => v && String(v).trim() && !/^closed$/i.test(String(v).trim()))
    .map(([day, v]) => `${day} ${String(v).trim()}`);
  return out.length ? out.join('; ') : null;
}
/**
 * North Carolina DMV MCP — live wait times at every NCDMV driver license office and
 * license plate agency, plus the office directory those same units carry. Keyless.
 *
 * One pack per state agency: North Carolina's grain is a live queue reading per office,
 * refreshed continuously by NCDOT's own Instant Wait Time service. That has nothing in
 * common with California's ZIP × fuel registration snapshot or New York's record-level
 * file, so it gets its own tools with its own real arguments.
 *
 * North Carolina and Oregon are the only two states that publish a machine-readable
 * live DMV wait feed at all — every other state's is captcha-gated, blocked to bots,
 * broken, or only inside a phone app.
 *
 * Source (verified live 2026-07-29):
 *   wait.services.ncdot.gov/IWT/IWTWeb/XmlStats.aspx — XML unit list.
 *     UnitID=2   driver license offices (1 root + 11 districts + 148 offices)
 *     UnitID=182 vehicle services / license plate agencies (LPA)
 *
 * Two shapes of the feed bite every caller and are handled here rather than passed on:
 *   1. It is a TREE, not a list. UnitID=2 returns a "Driver Services" root at UnitLevel 1,
 *      eleven districts at level 2, the real offices at level 3, and a sentinel unit named
 *      "Invalid". UnitID=182's two real units sit at level 2. So the leaves are kept by
 *      parent-reference (any UnitId never named as another unit's ParentUnitId) rather than
 *      by filtering on UnitLevel, which survives NCDOT re-organising the tree.
 *   2. Outside posted business hours every office reports OfficeStatus "Closed" with
 *      0:00:00 waits. That is the agency reporting an idle queue, not a missing value and
 *      not an error, so the status is returned as-is with a `note` saying so.
 *
 * Every tool resolves to a shaped object and never throws; a query that cannot be answered
 * comes back as { found: false, reason, hint }.
 */


const UA = 'pipeworx-mcp-nc-dmv/1.0 (+https://pipeworx.io)';
const FEED = 'https://wait.services.ncdot.gov/IWT/IWTWeb/XmlStats.aspx?controller=IWT_UnitsListXML&UnitID=';

/** The feed's two roots. `driver` is the ~148-office network agents usually mean. */
const SERVICE_UNITS: Record<string, { unit: string; label: string; singular: string; type: string }> = {
  driver: {
    unit: '2',
    label: 'Driver license offices',
    singular: 'driver license office',
    type: 'Driver license office',
  },
  vehicle: {
    unit: '182',
    label: 'Vehicle services / license plate agencies',
    singular: 'vehicle services / license plate agency unit',
    type: 'Vehicle services / license plate agency',
  },
};

const SOURCE = 'NCDOT Instant Wait Time service (wait.services.ncdot.gov)';

// ── Feed parsing ────────────────────────────────────────────────────

/** Text of a child tag, with the feed's "--" null sentinel and blanks mapped to null. */
function xmlTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) return null;
  const v = m[1].trim();
  return v === '' || v === '--' ? null : v;
}

/** "H:MM:SS" → whole minutes. NCDOT publishes waits only in this form. */
function hmsToMinutes(v: string | null): number | null {
  if (!v) return null;
  const m = v.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (!m) return null;
  return Math.round(Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 60);
}

/**
 * Addresses arrive as one string — "521 S. Sandhills Blvd., Aberdeen, NC 28315" — and the
 * separate <ZipCode> tag is empty on every unit, so the ZIP has to come out of this line.
 * The line is not consistently punctuated: a dozen offices embed newlines, omit the comma
 * before the city, or drop "NC" entirely ("2479 E. Fifth St., Lumberton  28358").
 *
 * So this peels from the right — ZIP, then the state token, then the city at the last
 * comma — instead of matching one rigid pattern. When what is left has no comma the city
 * cannot be told from the street ("16 Patton Ave. Franklin"), and the full string is
 * returned in `address` rather than guessing a city out of a street line.
 */
function splitAddress(raw: string | null): { address: string | null; city: string | null; zip: string | null } {
  if (!raw) return { address: null, city: null, zip: null };
  const norm = raw.replace(/\s*\n\s*/g, ', ').replace(/\s{2,}/g, ' ').replace(/(,\s*){2,}/g, ', ').trim();

  const zipMatch = norm.match(/(\d{5})(?:-\d{4})?\s*$/);
  const zip = zipMatch ? zipMatch[1] : null;
  let rest = zipMatch ? norm.slice(0, zipMatch.index).trim() : norm;
  rest = rest.replace(/[,\s]*(?:N\.?\s?C\.?|North Carolina)[,\s]*$/i, '').replace(/[,\s]+$/, '');

  const comma = rest.lastIndexOf(',');
  if (comma > 0) {
    const city = rest.slice(comma + 1).trim();
    // A trailing suite or route number is not a city; keep the line whole when it looks like one.
    if (city && city.length <= 30 && /^[A-Za-z][A-Za-z .'\-]*$/.test(city)) {
      return { address: rest.slice(0, comma).trim(), city, zip };
    }
  }
  return { address: rest || norm, city: null, zip };
}

interface NcOffice {
  unit_id: string;
  name: string;
  district: string | null;
  address: string | null;
  city: string | null;
  zip: string | null;
  full_address: string | null;
  phone: string | null;
  hours: string | null;
  description: string | null;
  status: string | null;
  is_open: boolean;
  avg_wait_minutes: number | null;
  max_wait_minutes: number | null;
}

/**
 * Load the leaf offices for one service. `ZipCode` is a separate tag on some units and
 * absent on others, so it is preferred over the ZIP parsed out of the address line.
 */
async function loadOffices(service: 'driver' | 'vehicle'): Promise<NcOffice[]> {
  const xml = await govFetchText(`${FEED}${SERVICE_UNITS[service].unit}`, {
    accept: 'application/xml,text/xml',
    userAgent: UA,
  });
  const raw = [...xml.matchAll(/<Unit UnitId="(\d+)">([\s\S]*?)<\/Unit>/g)];
  if (!raw.length) {
    throw new Error('NCDOT returned no <Unit> blocks — the wait-time feed changed shape or served an error page');
  }
  // The "Invalid" sentinel has to go BEFORE parents are computed: it hangs off a real
  // office (Greensboro West today), so counting its parent reference would silently drop
  // that office from the results — 147 offices where the agency publishes 148.
  const blocks = raw.filter(([, , body]) => (xmlTag(body, 'UnitName') ?? '') !== 'Invalid');
  // Of what is left, any unit named as somebody's parent is a root or a district, not an office.
  const parentIds = new Set(
    blocks.map(([, , body]) => xmlTag(body, 'ParentUnitId')).filter((v): v is string => Boolean(v)),
  );
  return blocks
    .filter(([, id]) => !parentIds.has(id))
    .map(([, id, body]) => {
      const status = xmlTag(body, 'OfficeStatus');
      const parsed = splitAddress(xmlTag(body, 'Address'));
      return {
        unit_id: id,
        name: xmlTag(body, 'UnitName') ?? '',
        district: xmlTag(body, 'ParentUnitName'),
        address: parsed.address,
        city: parsed.city,
        zip: xmlTag(body, 'ZipCode') ?? parsed.zip,
        full_address: xmlTag(body, 'Address'),
        phone: xmlTag(body, 'OfficePhone'),
        hours: xmlTag(body, 'OfficeHours'),
        description: xmlTag(body, 'Description'),
        status,
        is_open: govContains(status, 'open'),
        avg_wait_minutes: hmsToMinutes(xmlTag(body, 'AvgWT')),
        max_wait_minutes: hmsToMinutes(xmlTag(body, 'MaxWT')),
      };
    });
}

function resolveService(args: Record<string, unknown>): 'driver' | 'vehicle' {
  return (govString(args, 'service') ?? 'driver').toLowerCase().startsWith('veh') ? 'vehicle' : 'driver';
}

const tools: McpToolExport['tools'] = [
  {
    name: 'nc_dmv_wait_times',
    description:
      'Live wait times at North Carolina DMV offices, published by NCDMV itself and refreshed continuously: the current average wait in minutes, the longest wait anyone in line is seeing, and whether each office is open right now. Covers all 148 NCDMV driver license offices statewide plus the vehicle services and license plate agency units, so it answers "how long is the wait at the Raleigh DMV", "is the Charlotte DMV open right now", "which DMV near Greensboro has the shortest line", or "shortest DMV wait in North Carolina today". North Carolina is one of only two states whose DMV publishes a live queue feed. Outside posted business hours the agency reports every office closed with a zero wait, which is an idle queue rather than a measurement, and the response says so.',
    inputSchema: {
      type: 'object',
      properties: {
        office: { type: 'string', description: 'Case-insensitive office-name substring, e.g. "Raleigh", "Charlotte", "Wilmington".' },
        service: { type: 'string', description: '"driver" for driver license offices (default, 148 offices) or "vehicle" for vehicle services / license plate agency units.' },
        open_only: { type: ['boolean', 'string'], description: 'When true, keep only offices the feed currently reports as open.' },
        sort: { type: 'string', description: '"wait" ranks shortest average wait first (open offices first); "name" (default) keeps the agency\'s own order.' },
        limit: { type: ['number', 'string'], description: 'Max offices to return (default 200, max 400).' },
      },
    },
  },
  {
    name: 'nc_dmv_offices',
    description:
      'Find North Carolina DMV driver license offices and license plate agencies with street address, city, ZIP, phone number and posted opening hours. NCDMV publishes no other machine-readable office directory, so this is the office locator for the state: it answers "DMV offices in Raleigh", "address and hours of the Durham DMV", "phone number for the Asheville driver license office", or "license plate agency near Charlotte". Search by office name, city or ZIP. Each office also carries its NCDMV district. For the live queue at these same offices use nc_dmv_wait_times.',
    inputSchema: {
      type: 'object',
      properties: {
        office: { type: 'string', description: 'Case-insensitive office-name substring, e.g. "Raleigh", "Cary".' },
        city: { type: 'string', description: 'City name, matched as a substring, e.g. "Durham", "Winston-Salem".' },
        zip: { type: 'string', description: 'Five-digit ZIP code, e.g. "27604". A prefix such as "276" also matches.' },
        service: { type: 'string', description: '"driver" for driver license offices (default) or "vehicle" for vehicle services / license plate agency units.' },
        district: { type: 'string', description: 'NCDMV district name substring, e.g. "District 5".' },
        limit: { type: ['number', 'string'], description: 'Max offices to return (default 200, max 400).' },
      },
    },
  },
];

// ── Handlers ────────────────────────────────────────────────────────

async function waitTimes(args: Record<string, unknown>): Promise<unknown> {
  const service = resolveService(args);
  let list = await loadOffices(service);
  const total = list.length;

  const office = govString(args, 'office');
  if (office) list = list.filter((o) => govContains(o.name, office) || govContains(o.full_address, office));
  const openOnly = args.open_only === true || args.open_only === 'true';
  if (openOnly) list = list.filter((o) => o.is_open);

  if (!list.length) {
    return govNotFound(
      'no_matching_offices',
      office
        ? `No North Carolina ${SERVICE_UNITS[service].singular} matched "${office}". Call nc_dmv_wait_times with no arguments to list all ${total}, or try a bare city name such as "Raleigh".`
        : `Every one of the ${total} North Carolina offices is reporting closed right now — NCDMV disables the queue outside posted business hours. Call without open_only to see each office's posted hours and last reported status.`,
      { state: 'NC', source: SOURCE, filters_applied: { office, open_only: openOnly, service }, offices_in_feed: total },
    );
  }

  if ((govString(args, 'sort') ?? '').toLowerCase() === 'wait') {
    // Closed offices all read 0 minutes, so they would otherwise win a shortest-wait sort.
    list = [...list].sort((a, b) => {
      if (a.is_open !== b.is_open) return a.is_open ? -1 : 1;
      return (a.avg_wait_minutes ?? Number.MAX_SAFE_INTEGER) - (b.avg_wait_minutes ?? Number.MAX_SAFE_INTEGER);
    });
  }

  const open = list.filter((o) => o.is_open);
  const limit = govLimit(args.limit, 200, 400);
  const waits = open.map((o) => o.avg_wait_minutes).filter((v): v is number => v !== null);
  return {
    state: 'NC',
    source: SOURCE,
    service: SERVICE_UNITS[service].label,
    grain: 'live queue reading per office, as published by NCDMV at the moment of the call',
    office_count: list.length,
    offices_open: open.length,
    ...(waits.length
      ? {
          longest_avg_wait_minutes: Math.max(...waits),
          shortest_avg_wait_minutes: Math.min(...waits),
        }
      : {}),
    offices: list.slice(0, limit).map((o) => ({
      name: o.name,
      status: o.status,
      is_open: o.is_open,
      avg_wait_minutes: o.avg_wait_minutes,
      max_wait_minutes: o.max_wait_minutes,
      address: o.address,
      city: o.city,
      zip: o.zip,
      phone: o.phone,
      hours: o.hours,
      district: o.district,
      unit_id: o.unit_id,
    })),
    truncated: list.length > limit,
    note:
      open.length === 0
        ? 'Every office is reporting closed, so these wait figures are idle-queue zeros published by NCDMV rather than live measurements. Posted hours are in each office\'s `hours` field.'
        : 'Waits read 0 and status reads Closed for any office outside its posted hours; that is NCDMV reporting an idle queue, not a missing value.',
  };
}

async function offices(args: Record<string, unknown>): Promise<unknown> {
  const service = resolveService(args);
  let list = await loadOffices(service);
  const total = list.length;

  const office = govString(args, 'office');
  if (office) list = list.filter((o) => govContains(o.name, office));
  const city = govString(args, 'city');
  if (city) list = list.filter((o) => govContains(o.city, city) || govContains(o.full_address, city));
  const zip = govString(args, 'zip');
  if (zip) list = list.filter((o) => (o.zip ?? '').startsWith(zip));
  const district = govString(args, 'district');
  if (district) list = list.filter((o) => govContains(o.district, district));

  if (!list.length) {
    return govNotFound(
      'no_matching_offices',
      `No North Carolina ${SERVICE_UNITS[service].singular} matched those filters. Drop the narrowest one — `
        + `\`zip\` and \`district\` are the usual culprits — or call nc_dmv_offices with no arguments for the full list of ${total}.`,
      { state: 'NC', source: SOURCE, filters_applied: { office, city, zip, district, service }, offices_in_feed: total },
    );
  }

  const limit = govLimit(args.limit, 200, 400);
  const missingAddress = list.filter((o) => !o.full_address).length;
  return {
    state: 'NC',
    source: SOURCE,
    service: SERVICE_UNITS[service].label,
    grain: 'one row per NCDMV office, with the address and hours the agency posts',
    office_count: list.length,
    offices_missing_address: missingAddress,
    offices: list.slice(0, limit).map((o) => ({
      state: 'NC',
      office_type: SERVICE_UNITS[service].type,
      name: o.name,
      address: o.address,
      city: o.city,
      zip: o.zip,
      full_address: o.full_address,
      phone: o.phone,
      hours: o.hours,
      description: o.description,
      district: o.district,
      status: o.status,
      unit_id: o.unit_id,
    })),
    truncated: list.length > limit,
    note:
      'Addresses and hours come from the same NCDOT wait-time feed that serves live queue lengths, so `status` reads Closed for every office outside posted hours. For current waits use nc_dmv_wait_times.'
      + (missingAddress
        ? ` NCDMV leaves the address blank on ${missingAddress} of these offices; their name is still the one the agency uses, and \`hours\` is populated.`
        : ''),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'nc_dmv_wait_times': return await waitTimes(args);
      case 'nc_dmv_offices': return await offices(args);
      default:
        return govNotFound('unknown_tool', `nc-dmv exposes ${tools.map((t) => t.name).join(', ')}.`, { requested_tool: name });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `nc-dmv/${name}: ${message}`,
      hint: /timeout|abort/i.test(message)
        ? 'The NCDOT wait-time service timed out. Retry once — it is a single small XML document, so a stall is usually transient.'
        : 'NCDOT refused the request or changed the feed shape. Retry once; if it persists the XmlStats endpoint may have moved, and or_dmv_wait_times is the other state feed that publishes live DMV waits.',
    };
  }
}

export default { tools, callTool } satisfies McpToolExport;
export { tools, callTool };
