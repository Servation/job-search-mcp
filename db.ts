/**
 * Single-file JSON store, ported from the original job-search-agent (server/db.ts).
 *
 * Changes for the MCP App:
 *  - Per-user storage path (never writes into node_modules): installed -> ~/.job-search-mcp/jobs.json;
 *    running from source (tsx) -> ./data/jobs.json; JOB_SEARCH_MCP_DATA overrides. Mirrors Memora.
 *  - Dropped llmConfig (no external LLM) and watchlist (triage is scanned/saved/dismissed).
 *  - Atomic writes (tmp + rename).
 *
 * All logging goes to stderr; stdout is reserved for the stdio JSON-RPC stream.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Job, ResumeProfile, WorkdayCompany } from "./types.js";

// Resolve the store path whether running from source (tsx, .ts) or compiled (dist/db.js).
const fromSource = import.meta.filename.endsWith(".ts");
const PROJECT_ROOT = fromSource ? import.meta.dirname : path.join(import.meta.dirname, "..");

export const DB_PATH = process.env.JOB_SEARCH_MCP_DATA
  ? path.resolve(process.env.JOB_SEARCH_MCP_DATA)
  : fromSource
    ? path.join(PROJECT_ROOT, "data", "jobs.json")
    : path.join(os.homedir(), ".job-search-mcp", "jobs.json");

export interface PendingWorkday {
  host: string;
  tenant: string;
  site: string;
  consecutiveFailures: number;
  lastAttempt?: string;
}

export interface DatabaseSchema {
  scannedJobs: Job[]; // discovered, awaiting evaluation/triage
  savedJobs: Job[]; // applied / tracking
  dismissedJobs: Job[]; // explicitly rejected
  profile: ResumeProfile | null;
  logs: string[];
  stats: {
    totalScanned: number;
    duplicatesPrevented: number;
    evaluations: number;
    totalSourced: number;
  };
  workdayDirectory: WorkdayCompany[]; // user-discovered Workday boards
  pendingWorkdayValidation: PendingWorkday[];
  seen: Record<string, string>; // recency ledger: dedup key (title|company or url) -> last-seen ISO timestamp
}

function emptyDb(): DatabaseSchema {
  return {
    scannedJobs: [],
    savedJobs: [],
    dismissedJobs: [],
    profile: null,
    logs: [],
    stats: { totalScanned: 0, duplicatesPrevented: 0, evaluations: 0, totalSourced: 0 },
    workdayDirectory: [],
    pendingWorkdayValidation: [],
    seen: {},
  };
}

const cleanStr = (s: string) => s.toLowerCase().trim();

/**
 * In-place hygiene on scannedJobs: drop ones already saved/dismissed, drop blocked
 * companies, and enforce the per-company match cap. Returns true if it changed anything.
 */
export function cleanDbScannedJobs(db: DatabaseSchema): boolean {
  const originalLength = db.scannedJobs.length;
  const companyCounts = new Map<string, number>();
  const maxPerCompany = db.profile?.maxMatchesPerCompany || 3;
  const limitCompany = db.profile?.limitCompanyMatches !== false;
  const blockedSet = new Set((db.profile?.blockedCompanies || []).map(cleanStr));

  db.scannedJobs = db.scannedJobs.filter((job) => {
    const titleL = cleanStr(job.title);
    const companyL = cleanStr(job.company);

    const isSaved = db.savedJobs.some((s) => cleanStr(s.title) === titleL && cleanStr(s.company) === companyL);
    const isDismissed = db.dismissedJobs.some((d) => cleanStr(d.title) === titleL && cleanStr(d.company) === companyL);
    if (isSaved || isDismissed) return false;

    if (blockedSet.has(companyL)) return false;

    if (limitCompany) {
      const currentCount = companyCounts.get(companyL) || 0;
      if (currentCount >= maxPerCompany) return false;
      companyCounts.set(companyL, currentCount + 1);
    }
    return true;
  });

  return db.scannedJobs.length !== originalLength;
}

/** Coerce a parsed JSON object into a well-formed DatabaseSchema (tolerant of old/missing fields). */
function coerce(parsed: Record<string, unknown>): DatabaseSchema {
  const base = emptyDb();
  const stats = (parsed.stats as Partial<DatabaseSchema["stats"]>) || {};
  return {
    scannedJobs: (parsed.scannedJobs as Job[]) || [],
    savedJobs: (parsed.savedJobs as Job[]) || [],
    dismissedJobs: (parsed.dismissedJobs as Job[]) || [],
    profile: (parsed.profile as ResumeProfile | null) || null,
    logs: (parsed.logs as string[]) || [],
    stats: {
      totalScanned: typeof stats.totalScanned === "number" ? stats.totalScanned : 0,
      duplicatesPrevented: typeof stats.duplicatesPrevented === "number" ? stats.duplicatesPrevented : 0,
      evaluations: typeof stats.evaluations === "number" ? stats.evaluations : 0,
      totalSourced: typeof stats.totalSourced === "number" ? stats.totalSourced : 0,
    },
    workdayDirectory: (parsed.workdayDirectory as WorkdayCompany[]) || base.workdayDirectory,
    pendingWorkdayValidation: (parsed.pendingWorkdayValidation as PendingWorkday[]) || base.pendingWorkdayValidation,
    seen: (parsed.seen as Record<string, string>) || {},
  };
}

export function readDb(): DatabaseSchema {
  try {
    if (fs.existsSync(DB_PATH)) {
      const db = coerce(JSON.parse(fs.readFileSync(DB_PATH, "utf-8")));
      if (cleanDbScannedJobs(db)) writeDb(db);
      return db;
    }
  } catch (err) {
    console.error("[DB] Error reading database file:", err);
  }
  return emptyDb();
}

export function writeDb(db: DatabaseSchema): void {
  try {
    cleanDbScannedJobs(db);
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const tmp = DB_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf-8");
    fs.renameSync(tmp, DB_PATH); // atomic, safe for concurrent reads
  } catch (err) {
    console.error("[DB] Error writing database file:", err);
  }
}
