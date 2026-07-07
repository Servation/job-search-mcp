/**
 * find_jobs orchestration: refresh the registry, run all scrapers in parallel,
 * convert to our Job model, structurally filter + dedup URLs, optionally
 * network-verify, persist unscored jobs to the store, and return them.
 *
 * Scoring is NOT done here: jobs come back unscored (matchScore = -1). Claude
 * evaluates them later (evaluate_jobs) by assigning a holistic 0-100 fit score,
 * which the server clamps + persists (applyHolisticScore).
 */
import crypto from "node:crypto";
import { globalState } from "./config.js";
import { readDb, writeDb } from "./db.js";
import {
  updateCompanyDirectoriesFromRegistry,
  fetchGreenhouseJobs,
  fetchLeverJobs,
  fetchAshbyJobs,
  fetchWorkdayJobs,
  fetchSmartRecruitersJobs,
  fetchRemoteOKJobs,
  fetchRemotiveJobs,
  fetchHackerNewsJobs,
  fetchLinkedInJobs,
  fetchLinkedInJobDetail,
  linkedInJobIdFromUrl,
  type RawCommunityJob,
  type LinkedInQuery,
} from "./sourcing.js";
import { extractRoleKeywords, isSpecificJobPost, normalizeJobUrl, verifyJobUrl, asyncMapConcurrent } from "./utils.js";
import type { Job, JobTypeType, ResumeProfile } from "./types.js";

export interface FindCriteria {
  query?: string;
  location?: string;
  verifyUrls?: boolean;
  limit?: number;
  experienceLevel?: string; // "entry level" | "associate" | "senior" | "director" | "executive"
  jobType?: string; // "full time" | "part time" | "contract" | ...
  datePosted?: string; // "24hr" | "past week" | "past month"
  remote?: string; // "on site" | "remote" | "hybrid"
  salaryMin?: number;
  maxApplicants?: number; // drop LinkedIn jobs with more applicants than this
  maxYears?: number; // candidate years for this search (overrides profile; drives level mapping + seniority blocklist)
  sortBy?: string; // "recent" | "relevant"
  sources?: string[]; // restrict to a subset of the 9 source names
}

export interface SourceResult {
  jobs: Job[]; // freshly found, unscored
  profile: ResumeProfile | null;
  sourced: number; // total raw postings fetched
  fresh: number; // new after structural filter + dedup
  kept: number; // after the cap
  bySource: Record<string, number>; // raw postings fetched per source name (0 = source returned nothing this run)
}

const DEFAULT_LIMIT = 15;
const cleanStr = (s: string) => s.toLowerCase().trim();

// Recency ledger: a job shown within this window is not re-surfaced even after it ages
// off the board or is cleared. Past the window it may resurface (catches genuine re-posts).
const SEEN_WINDOW_MS = 182 * 24 * 60 * 60 * 1000; // ~6 months
const SEEN_MAX = 8000;

/** Drop ledger entries older than `cutoff` (ms epoch) and cap to the most recent `max`. */
export function capLedger(m: Record<string, string>, cutoff: number, max: number): Record<string, string> {
  let entries = Object.entries(m).filter(([, ts]) => Date.parse(ts) >= cutoff);
  if (entries.length > max) {
    entries.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]));
    entries = entries.slice(0, max);
  }
  return Object.fromEntries(entries);
}

function normType(t: string): JobTypeType {
  const s = (t || "").toLowerCase();
  if (s.includes("contract")) return "Contract";
  if (s.includes("part")) return "Part-Time";
  return "Full-Time";
}

/** Stable id from the normalized URL (falls back to title|company), prefixed by source. */
function stableId(r: RawCommunityJob): string {
  const basis = normalizeJobUrl(r.url) || `${cleanStr(r.title)}|${cleanStr(r.company)}`;
  return `${r.source}_${crypto.createHash("sha1").update(basis).digest("hex").slice(0, 12)}`;
}

function rawToJob(r: RawCommunityJob): Job {
  return {
    id: stableId(r),
    title: r.title,
    company: r.company,
    location: r.location,
    salary: r.salary,
    type: normType(r.type),
    isW2: true,
    description: r.description,
    url: r.url,
    postedAt: r.postedAt,
    matchScore: -1, // unscored until Claude evaluates it
    isDuplicate: false,
    status: "discovered",
    scannedAt: new Date().toISOString(),
    isRemote: r.isRemote,
    sourceTag: r.source,
  };
}

/**
 * Round-robin across sources (one per source per cycle) and skip a posting whose
 * company already hit the cap. maxPerCompany <= 0 disables the cap.
 */
function interleaveAndCap(raws: RawCommunityJob[], maxPerCompany: number): RawCommunityJob[] {
  const bySource = new Map<string, RawCommunityJob[]>();
  for (const r of raws) {
    const arr = bySource.get(r.source) ?? [];
    arr.push(r);
    bySource.set(r.source, arr);
  }
  const queues = [...bySource.values()];
  const companyCount = new Map<string, number>();
  const out: RawCommunityJob[] = [];

  let active = true;
  while (active) {
    active = false;
    for (const q of queues) {
      while (q.length) {
        active = true;
        const cand = q.shift()!;
        const c = cleanStr(cand.company);
        const n = companyCount.get(c) ?? 0;
        if (maxPerCompany > 0 && n >= maxPerCompany) continue; // over cap, drop and try next in this source
        companyCount.set(c, n + 1);
        out.push(cand);
        break; // move to next source for round-robin variety
      }
    }
  }
  return out;
}

/** Map candidate years of experience to a LinkedIn seniority level (undefined = unknown). */
export function yoeToLinkedInLevel(years: number): string | undefined {
  if (years < 1) return undefined;
  if (years < 2) return "entry level";
  if (years <= 4) return "associate";
  if (years <= 9) return "senior";
  if (years <= 14) return "director";
  return "executive";
}

/** Effective search inputs: stored profile, with criteria overrides; synthesized if no profile yet. */
function searchInputs(profile: ResumeProfile | null, criteria: FindCriteria) {
  const targetRoles = criteria.query
    ? [criteria.query, ...(profile?.targetRoles ?? [])]
    : profile?.targetRoles?.length
      ? profile.targetRoles
      : ["Software Engineer"];
  const keywords = extractRoleKeywords(targetRoles);
  const searchLocation = criteria.location ?? profile?.searchLocation ?? "";
  const prefersRemote = criteria.remote ? criteria.remote.toLowerCase() === "remote" : profile?.prefersRemote ?? true;
  // max_years overrides the profile's years for this search (drives both seniority blocklisting and level mapping).
  const yoe = criteria.maxYears ?? profile?.yearsOfExperience ?? 0;
  const skills = profile?.parsedSkills ?? [];
  // LinkedIn does its own keyword search, so it wants a phrase, not our tokenized list.
  const keyword = criteria.query || profile?.targetRoles?.[0] || "Software Engineer";
  // Default the LinkedIn seniority filter from the candidate's years when not given explicitly.
  const experienceLevel = criteria.experienceLevel ?? yoeToLinkedInLevel(yoe);
  return { targetRoles, keywords, searchLocation, prefersRemote, yoe, skills, keyword, experienceLevel };
}

/**
 * Run all scrapers, dedup, optionally verify, persist unscored jobs, and return the fresh ones.
 */
export async function sourceJobs(criteria: FindCriteria): Promise<SourceResult> {
  await updateCompanyDirectoriesFromRegistry();

  const db = readDb();
  const profile = db.profile;
  const { targetRoles, keywords, searchLocation, prefersRemote, yoe, skills, keyword, experienceLevel } = searchInputs(profile, criteria);
  const limit = criteria.limit ?? profile?.maxDiscoveredJobs ?? DEFAULT_LIMIT;

  const liQuery: LinkedInQuery = {
    keyword,
    location: searchLocation,
    targetRoles,
    yearsOfExperience: yoe,
    prefersRemote,
    datePosted: criteria.datePosted,
    remote: criteria.remote,
    jobType: criteria.jobType,
    experienceLevel,
    salaryMin: criteria.salaryMin,
    sortBy: criteria.sortBy,
    maxApplicants: criteria.maxApplicants,
    limit,
  };

  // Build the source fan-out, honoring the optional `sources` filter. An unset OR
  // empty array means "all 9 sources" (empty must not select zero).
  const srcFilter = criteria.sources && criteria.sources.length ? criteria.sources : undefined;
  const wantSrc = (name: string) => !srcFilter || srcFilter.includes(name);
  const tasks: { source: string; run: Promise<RawCommunityJob[]> }[] = [];
  const add = (source: string, run: Promise<RawCommunityJob[]>) => tasks.push({ source, run });
  if (wantSrc("linkedin")) add("linkedin", fetchLinkedInJobs(liQuery));
  if (wantSrc("greenhouse")) add("greenhouse", fetchGreenhouseJobs(globalState.cachedGreenhouseSlugs, keywords, targetRoles, searchLocation, prefersRemote, yoe));
  if (wantSrc("lever")) add("lever", fetchLeverJobs(globalState.cachedLeverSlugs, keywords, targetRoles, searchLocation, prefersRemote, yoe));
  if (wantSrc("ashby")) add("ashby", fetchAshbyJobs(globalState.cachedAshbySlugs, keywords, targetRoles, searchLocation, prefersRemote, yoe));
  if (wantSrc("workday")) add("workday", fetchWorkdayJobs(globalState.cachedWorkdayDirectory, keywords, targetRoles, searchLocation, prefersRemote, yoe));
  if (wantSrc("smartrecruiters")) add("smartrecruiters", fetchSmartRecruitersJobs(globalState.cachedSmartRecruitersDirectory, keywords, targetRoles, searchLocation, prefersRemote, yoe));
  if (wantSrc("hackernews")) add("hackernews", fetchHackerNewsJobs(keywords, skills, targetRoles, searchLocation, prefersRemote, yoe));
  if (wantSrc("remoteok")) add("remoteok", fetchRemoteOKJobs(keywords, skills, targetRoles, searchLocation, prefersRemote, yoe));
  if (wantSrc("remotive")) add("remotive", fetchRemotiveJobs(keywords, skills, targetRoles, searchLocation, prefersRemote, yoe));

  // Each scraper already swallows its own errors and returns []; allSettled is a backstop.
  // Track raw postings PER SOURCE so a dead/blocked source shows as "0" instead of being
  // indistinguishable from a narrow search that legitimately matched nothing.
  const settled = await Promise.allSettled(tasks.map((t) => t.run));
  const bySource: Record<string, number> = {};
  settled.forEach((s, i) => {
    bySource[tasks[i].source] = s.status === "fulfilled" ? s.value.length : 0;
  });
  const raw: RawCommunityJob[] = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
  const sourced = raw.length;

  // Structural URL filter (no network): drop generic career/root pages.
  const structurallyOk = raw.filter((r) => r.url && isSpecificJobPost(r.url));

  // Recency ledger of jobs shown within the last ~6 months (survives board age-out / clear_jobs).
  const cutoff = Date.now() - SEEN_WINDOW_MS;
  const ledger = db.seen ?? {};
  const ledgerActive = new Set<string>();
  for (const [k, ts] of Object.entries(ledger)) if (Date.parse(ts) >= cutoff) ledgerActive.add(k);

  // Dedup vs the store (board + tracker + dismissed), the recency ledger, and within this batch.
  const existing = new Set<string>();
  for (const j of [...db.scannedJobs, ...db.savedJobs, ...db.dismissedJobs]) {
    existing.add(`${cleanStr(j.title)}|${cleanStr(j.company)}`);
    if (j.url) existing.add(normalizeJobUrl(j.url));
  }
  const batchSeen = new Set<string>();
  const freshRaw: RawCommunityJob[] = [];
  for (const r of structurallyOk) {
    const kTitle = `${cleanStr(r.title)}|${cleanStr(r.company)}`;
    const kUrl = normalizeJobUrl(r.url);
    if (
      existing.has(kTitle) ||
      existing.has(kUrl) ||
      ledgerActive.has(kTitle) ||
      ledgerActive.has(kUrl) ||
      batchSeen.has(kTitle) ||
      batchSeen.has(kUrl)
    )
      continue;
    batchSeen.add(kTitle);
    batchSeen.add(kUrl);
    freshRaw.push(r);
  }

  // Interleave round-robin across sources and enforce the per-company cap, so the
  // returned set is diverse instead of dominated by whichever source is largest.
  const limitCompany = profile?.limitCompanyMatches !== false;
  const maxPerCompany = limitCompany ? profile?.maxMatchesPerCompany ?? 3 : 0;
  const ordered = interleaveAndCap(freshRaw, maxPerCompany);

  // When filtering by applicant count, over-fetch candidates (bounded) so we can drop
  // over-cap LinkedIn jobs and still return ~limit.
  const candidateCount = criteria.maxApplicants !== undefined ? Math.min(limit * 3, 40) : limit;
  let candidates = ordered.slice(0, candidateCount).map(rawToJob);

  // LinkedIn detail pass: full JD + applicant count (their search results carry neither).
  // Bounded to the LinkedIn candidates, so only a few detail requests.
  const liCandidates = candidates.filter((j) => j.sourceTag === "linkedin");
  const earlyIds = new Set<string>();
  if (liCandidates.length) {
    const details = await asyncMapConcurrent(liCandidates, 5, async (j) => {
      const id = linkedInJobIdFromUrl(j.url);
      const d = id ? await fetchLinkedInJobDetail(id) : { description: "", applicants: null, early: false };
      return { id: j.id, d };
    });
    const byId = new Map(details.map((x) => [x.id, x.d]));
    for (const x of details) if (x.d.early) earlyIds.add(x.id);
    candidates = candidates.map((j) => {
      const d = byId.get(j.id);
      if (!d) return j;
      return {
        ...j,
        description: d.description.length > (j.description?.length ?? 0) ? d.description : j.description,
        applicants: d.applicants ?? j.applicants,
        isFullDescriptionFetched: d.description ? true : j.isFullDescriptionFetched,
      };
    });
  }

  // Applicant cap: drop a LinkedIn job only when its EXACT count is known and over the
  // cap. "Early applicant" jobs (upper-bound counts) and unknown counts are kept — those
  // are the low-competition jobs the cap is meant to surface.
  if (criteria.maxApplicants !== undefined) {
    const cap = criteria.maxApplicants;
    candidates = candidates.filter((j) => j.applicants == null || earlyIds.has(j.id) || j.applicants <= cap);
  }

  let kept = candidates.slice(0, limit);

  // Optional network verification (off by default to keep find_jobs fast). Non-fatal:
  // we mark isUrlVerified but never drop a job for a blocked/slow fetch.
  if (criteria.verifyUrls) {
    kept = await asyncMapConcurrent(kept, 8, async (j) => {
      const { isValid, resolvedUrl } = await verifyJobUrl(j.url);
      return { ...j, isUrlVerified: isValid, url: resolvedUrl || j.url };
    });
  } else {
    kept = kept.map((j) => ({ ...j, isUrlVerified: true })); // passed the structural check
  }

  // Persist. Re-read the store IMMEDIATELY before writing and apply our changes onto that
  // fresh copy, so writes made during the multi-second scrape await — Workday self-heal
  // (consecutiveFailures), refiner logs, and any concurrent UI triage (Apply/Skip) — are not
  // reverted by writing back a snapshot captured before those awaits.
  const fresh = readDb();
  const maxTotal = Math.max(limit, profile?.maxDiscoveredJobs ?? 100);
  fresh.scannedJobs = [...kept, ...fresh.scannedJobs].slice(0, maxTotal);
  fresh.stats.totalSourced += sourced;
  fresh.stats.totalScanned += kept.length;

  // Record the jobs we're showing into the fresh recency ledger; prune >6mo and cap.
  const nowIso = new Date().toISOString();
  const freshLedger = fresh.seen ?? {};
  for (const j of kept) {
    freshLedger[`${cleanStr(j.title)}|${cleanStr(j.company)}`] = nowIso;
    if (j.url) freshLedger[normalizeJobUrl(j.url)] = nowIso;
  }
  fresh.seen = capLedger(freshLedger, cutoff, SEEN_MAX);

  writeDb(fresh);

  return { jobs: kept, profile, sourced, fresh: freshRaw.length, kept: kept.length, bySource };
}
