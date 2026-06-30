/**
 * Job-search MCP server: tool + UI resource wiring.
 *
 * find_jobs runs the ported deterministic scrapers (Phase 2) and returns live,
 * deduped, UNSCORED jobs + the saved resume profile, rendering the inline review
 * UI. The host model (Claude) is the evaluator: later it calls evaluate_jobs with
 * extracted facts and the server scores via the ported computeMatchScore (Phase 4).
 * No external LLM, no API key.
 */
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import type { Job, ResumeProfile } from "./types.js";
import { sourceJobs, yoeToLinkedInLevel, type FindCriteria } from "./pipeline.js";
import { readDb, writeDb } from "./db.js";
import { applyHolisticScore } from "./scoring.js";

const RESOURCE_URI = "ui://job-search/review.html";

// Per-job description cap in the wire payload (full text stays in the store). Keeps
// the tool result large enough for Claude to extract facts without flooding context.
const SLIM_DESC_CAP = 3000;

// Resolve the bundled UI HTML whether running from source (tsx) or compiled
// (dist/server.js). Mirrors Memora's DIST_DIR pattern.
const fromSource = import.meta.filename.endsWith(".ts");
const DIST_DIR = fromSource ? path.join(import.meta.dirname, "dist") : import.meta.dirname;

/** Structured-output shape the review UI reads from `structuredContent`. */
const JOB_OUT = {
  id: z.string(),
  title: z.string(),
  company: z.string(),
  location: z.string(),
  url: z.string(),
  description: z.string(),
  postedAt: z.string(),
  status: z.string(),
  sourceTag: z.string().optional(),
  salary: z.string().optional(),
  isRemote: z.boolean().optional(),
  matchScore: z.number(), // -1 until evaluated
  matchReason: z.string().optional(),
  experienceLevel: z.string().optional(),
  skillsRequired: z.array(z.string()).optional(),
  applicants: z.number().optional(),
};

const PROFILE_OUT = z
  .object({
    parsedName: z.string().optional(),
    parsedSkills: z.array(z.string()).optional(),
    targetRoles: z.array(z.string()).optional(),
    searchLocation: z.string().optional(),
    prefersRemote: z.boolean().optional(),
    yearsOfExperience: z.number().optional(),
  })
  .nullable();

const FIND_JOBS_OUTPUT = {
  jobs: z.array(z.object(JOB_OUT)),
  count: z.number(),
  scored: z.boolean(),
  profile: PROFILE_OUT,
  view: z.string().optional(), // "board" | "saved" — lets the UI re-fetch the right view on remount
};

/**
 * Project a full Job to exactly the review-UI output shape. Full Job objects
 * carry server-internal fields (type, isW2, scannedAt, ...) that are NOT in the
 * tool's strict outputSchema; sending them would fail client-side validation
 * (additionalProperties: false). Only this slim shape goes over the wire; the
 * full Job lives in the store. Mirrors Memora's slimOf().
 */
function slimJob(j: Job) {
  const out: {
    id: string;
    title: string;
    company: string;
    location: string;
    url: string;
    description: string;
    postedAt: string;
    status: string;
    matchScore: number;
    sourceTag?: string;
    salary?: string;
    isRemote?: boolean;
    matchReason?: string;
    experienceLevel?: string;
    skillsRequired?: string[];
    applicants?: number;
  } = {
    // Defensive defaults: a malformed/old store entry must never emit `undefined`
    // for a required field (that would fail the whole board's output validation).
    id: j.id ?? "",
    title: j.title ?? "Untitled role",
    company: j.company ?? "Unknown",
    location: j.location ?? "",
    url: j.url ?? "",
    description: (j.description ?? "").slice(0, SLIM_DESC_CAP),
    postedAt: j.postedAt ?? j.scannedAt ?? "",
    status: j.status ?? "discovered",
    matchScore: typeof j.matchScore === "number" ? j.matchScore : -1,
  };
  if (j.sourceTag !== undefined) out.sourceTag = j.sourceTag;
  if (j.salary !== undefined) out.salary = j.salary;
  if (j.isRemote !== undefined) out.isRemote = j.isRemote;
  if (j.matchReason !== undefined) out.matchReason = j.matchReason;
  if (j.experienceLevel !== undefined) out.experienceLevel = j.experienceLevel;
  if (j.skillsRequired !== undefined) out.skillsRequired = j.skillsRequired;
  if (j.applicants !== undefined) out.applicants = j.applicants;
  return out;
}

/** Project the saved profile to the slim shape the UI header reads (or null). */
function slimProfile(profile: ResumeProfile | null) {
  if (!profile) return null;
  const out: {
    parsedName?: string;
    parsedSkills?: string[];
    targetRoles?: string[];
    searchLocation?: string;
    prefersRemote?: boolean;
    yearsOfExperience?: number;
  } = {};
  if (profile.parsedName !== undefined) out.parsedName = profile.parsedName;
  if (profile.parsedSkills !== undefined) out.parsedSkills = profile.parsedSkills;
  if (profile.targetRoles !== undefined) out.targetRoles = profile.targetRoles;
  if (profile.searchLocation !== undefined) out.searchLocation = profile.searchLocation;
  if (profile.prefersRemote !== undefined) out.prefersRemote = profile.prefersRemote;
  if (profile.yearsOfExperience !== undefined) out.yearsOfExperience = profile.yearsOfExperience;
  return out;
}

/** Compact candidate summary the model scores jobs against (shown alongside the jobs). */
function profileSummary(profile: ResumeProfile | null): string {
  if (!profile) return "Candidate: no saved profile — score against the criteria the user gave.";
  const parts: string[] = [];
  if (profile.parsedName) parts.push(profile.parsedName);
  if (typeof profile.yearsOfExperience === "number") parts.push(`${profile.yearsOfExperience}y experience`);
  if (profile.searchLocation) parts.push(profile.searchLocation);
  if (profile.targetRoles?.length) parts.push(`target roles: ${profile.targetRoles.slice(0, 5).join(", ")}`);
  if (profile.parsedSkills?.length) parts.push(`skills: ${profile.parsedSkills.slice(0, 16).join(", ")}`);
  return `Candidate — ${parts.join(" · ")}`;
}

// Per-job description excerpt included in TEXT content for evaluation. The model
// reads `content` text (not structuredContent), so the job id AND enough of the
// description to score it must live here.
const EVAL_EXCERPT = 1500;

/**
 * One text block per job: the EXACT id (in brackets, for evaluate_jobs), a header,
 * the URL, and a description excerpt. This is what lets Claude evaluate jobs.
 */
function jobEvalBlocks(jobs: Job[]): string {
  return jobs
    .map(
      (j) =>
        `[${j.id}] ${j.title} — ${j.company} (${j.location})${j.salary ? ` · ${j.salary}` : ""}\n` +
        `${j.url}\n` +
        `${(j.description ?? "").replace(/\s+/g, " ").trim().slice(0, EVAL_EXCERPT)}`,
    )
    .join("\n\n");
}

/** Build the review-UI result from a set of jobs (ranked by score desc), with a text note. */
function boardResult(jobs: Job[], profile: ResumeProfile | null, note: string): CallToolResult {
  const ranked = [...jobs].sort((a, b) => b.matchScore - a.matchScore);
  const slim = ranked.map(slimJob);
  return {
    content: [{ type: "text", text: note }],
    structuredContent: {
      jobs: slim,
      count: slim.length,
      scored: ranked.some((j) => j.matchScore >= 0),
      profile: slimProfile(profile),
      view: "board",
    },
  };
}

/** Creates the job-search MCP server with the find_jobs tool and review UI. */
export function createServer(): McpServer {
  const server = new McpServer({ name: "Job Search MCP", version: "0.1.0" });

  // find_jobs: run the deterministic scrapers (LinkedIn + 8 boards) and return live,
  // deduped, UNSCORED jobs as TEXT (ids + full descriptions). This tool does NOT render
  // a widget — the model immediately calls evaluate_jobs, which renders the single
  // ranked board. Keeping find_jobs text-only avoids the find→render→re-render churn.
  server.registerTool(
    "find_jobs",
    {
      title: "Find Jobs",
      description:
        "Source live jobs (LinkedIn + Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Hacker News, " +
        "RemoteOK, Remotive), dedup them, and return them as text with full descriptions. Uses the saved " +
        "profile's roles/location by default; pass query/location/filters to override. This returns UNSCORED " +
        "jobs and does NOT show a card UI — immediately score all of them with evaluate_jobs (a 0-100 fit score " +
        "+ reason each), then show_board once, to present the single ranked board. Do not just list them back.",
      inputSchema: {
        query: z.string().optional().describe("Role/keyword filter, e.g. 'backend java spring'. Overrides the profile's target roles."),
        location: z.string().optional().describe("Location filter, e.g. 'California' or 'Remote'. Overrides the profile's search location."),
        experience_level: z
          .enum(["internship", "entry level", "associate", "senior", "director", "executive"])
          .optional()
          .describe("Seniority filter (LinkedIn)."),
        job_type: z
          .enum(["full time", "part time", "contract", "temporary", "internship", "volunteer"])
          .optional()
          .describe("Employment type (LinkedIn)."),
        date_posted: z.enum(["24hr", "past week", "past month"]).optional().describe("Recency filter (LinkedIn)."),
        remote: z.enum(["on site", "remote", "hybrid"]).optional().describe("Workplace type (LinkedIn); also sets remote preference."),
        salary_min: z.number().optional().describe("Minimum annual salary filter (LinkedIn), e.g. 100000."),
        max_applicants: z
          .number()
          .optional()
          .describe("Surface low-applicant LinkedIn jobs (uses LinkedIn's early-applicant filter, ~under 25). Exact applicant-count filtering requires the LinkedIn cookie."),
        max_years: z
          .number()
          .optional()
          .describe("Candidate's years of experience for this search (overrides the saved profile); also defaults the seniority filter."),
        sort_by: z.enum(["recent", "relevant"]).optional().describe("LinkedIn result ordering."),
        sources: z
          .array(z.enum(["linkedin", "greenhouse", "lever", "ashby", "workday", "smartrecruiters", "hackernews", "remoteok", "remotive"]))
          .optional()
          .describe("Restrict to these sources (default: all)."),
        verify_urls: z.boolean().optional().describe("If true, network-verify each job URL (slower). Default false."),
        limit: z.number().optional().describe("Max jobs to return/persist this run (default 15)."),
      },
    },
    async ({
      query,
      location,
      experience_level,
      job_type,
      date_posted,
      remote,
      salary_min,
      max_applicants,
      max_years,
      sort_by,
      sources,
      verify_urls,
      limit,
    }): Promise<CallToolResult> => {
      const criteria: FindCriteria = {
        query,
        location,
        verifyUrls: verify_urls,
        limit,
        experienceLevel: experience_level,
        jobType: job_type,
        datePosted: date_posted,
        remote,
        salaryMin: salary_min,
        maxApplicants: max_applicants,
        maxYears: max_years,
        sortBy: sort_by,
        sources,
      };
      let result: Awaited<ReturnType<typeof sourceJobs>>;
      try {
        result = await sourceJobs(criteria);
      } catch (err: any) {
        return { isError: true, content: [{ type: "text", text: `Sourcing failed: ${err?.message ?? String(err)}` }] };
      }
      const { jobs, profile, sourced, kept } = result;

      const filters = [query && `query="${query}"`, location && `location="${location}"`].filter(Boolean).join(", ");
      const filterNote = filters ? ` for ${filters}` : profile ? " using your saved profile" : "";

      let text: string;
      if (kept === 0) {
        text =
          `No NEW jobs found${filterNote} (fetched ${sourced} postings; all were filtered out or already seen). ` +
          `Try a broader query or different filters — or call whats_promising to review/score jobs already on the board.`;
      } else {
        text =
          `${profileSummary(profile)}\n\n` +
          `Found ${kept} unscored job(s)${filterNote} (from ${sourced} postings sourced). These are NOT shown as cards.\n\n` +
          `Now SCORE each job 0-100 for this candidate (read its description; weigh must-haves, the candidate's skills ` +
          `and years, seniority realism, domain fit) and call evaluate_jobs with one { job_id, score, reason } per job ` +
          `for ALL of them using the EXACT bracketed ids below, then call show_board once to display the ranked board.\n\n` +
          jobEvalBlocks(jobs);
      }

      return { content: [{ type: "text", text }] };
    },
  );

  // evaluate_jobs: Claude submits extracted facts per job; the server scores each
  // deterministically (computeMatchScore), persists, and re-renders the ranked board.
  server.registerTool(
    "evaluate_jobs",
    {
      title: "Evaluate Jobs",
      description:
        "Score one or more sourced jobs for THIS candidate (holistic). YOU assign each job a 0-100 fit score " +
        "directly, using the candidate summary (shown in find_jobs / whats_promising) and the job description. " +
        "Weigh the must-have requirements, the candidate's actual skills and years of experience (a role demanding " +
        "far more seniority/years than the candidate has should score LOWER), domain fit, and standout strengths. " +
        "Calibrate and use the FULL range — do not bunch everything at 80+: 80-100 = strong fit and realistic; " +
        "60-79 = good with real gaps; 40-59 = partial/stretch (e.g. wrong level); below 40 = poor or wrong field. " +
        "Pass { job_id, score, reason } per job. Use the EXACT bracketed ids; do not invent them. Score every job " +
        "in one call. Returns text; call show_board afterward to display the ranked board.",
      inputSchema: {
        evaluations: z
          .array(
            z.object({
              job_id: z.string().describe("EXACT bracketed id from find_jobs/whats_promising."),
              score: z.number().describe("Holistic 0-100 fit score for the candidate (calibrated; see the tool description)."),
              reason: z.string().describe("One-line justification — what fits and what's the gap."),
              experience_level: z.enum(["Junior", "Mid", "Senior", "Lead"]).optional().describe("The role's seniority level."),
              industry: z.string().optional().describe("e.g. 'Technology', 'Finance'."),
              salary_num: z.number().optional().describe("Numeric annual salary if stated."),
              skills: z.array(z.string()).optional().describe("Key required skills (for display)."),
            }),
          )
          .describe("One entry per job to score."),
      },
    },
    async ({ evaluations }): Promise<CallToolResult> => {
      const db = readDb();
      let scored = 0;
      const notFound: string[] = [];

      for (const ev of evaluations) {
        const apply = (j: Job) =>
          applyHolisticScore(j, {
            score: ev.score,
            reason: ev.reason,
            experienceLevel: ev.experience_level,
            industry: ev.industry,
            salaryNum: ev.salary_num,
            skills: ev.skills,
          });
        const si = db.scannedJobs.findIndex((j) => j.id === ev.job_id);
        if (si >= 0) {
          db.scannedJobs[si] = apply(db.scannedJobs[si]);
          scored++;
          continue;
        }
        const vi = db.savedJobs.findIndex((j) => j.id === ev.job_id);
        if (vi >= 0) {
          db.savedJobs[vi] = apply(db.savedJobs[vi]);
          scored++;
          continue;
        }
        notFound.push(ev.job_id);
      }

      db.stats.evaluations += scored;
      writeDb(db);

      const ranked = [...db.scannedJobs].sort((a, b) => b.matchScore - a.matchScore);
      const top = ranked
        .filter((j) => j.matchScore >= 0)
        .slice(0, 5)
        .map((j, i) => `${i + 1}. ${j.matchScore} — ${j.title} @ ${j.company}${j.matchReason ? ` (${j.matchReason})` : ""}`)
        .join("\n");
      const note =
        `Scored ${scored} job(s).` +
        (notFound.length ? ` ${notFound.length} id(s) not found (already triaged?).` : "") +
        (top ? `\n\nTop matches:\n${top}` : "");

      return { content: [{ type: "text", text: `${note}\n\nNow call show_board to display the ranked board.` }] };
    },
  );

  // set_status: triage a job (called by the review UI's buttons, and usable by Claude).
  registerAppTool(
    server,
    "set_status",
    {
      title: "Set Job Status",
      description:
        "Triage a job by id: 'saved' (interested/tracking), 'applied' (also stamps the date), 'dismissed' " +
        "(skip), or 'discovered' (undo back to the board). Moves it between the scanned/saved/dismissed lists " +
        "and persists. Optionally attach notes. Called by the review UI; also usable directly.",
      inputSchema: {
        job_id: z.string().describe("The job's id."),
        status: z.enum(["saved", "applied", "dismissed", "discovered"]).describe("New triage status."),
        notes: z.string().optional().describe("Optional notes to attach to the job."),
      },
      outputSchema: FIND_JOBS_OUTPUT,
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ job_id, status, notes }): Promise<CallToolResult> => {
      const db = readDb();
      const found = [...db.scannedJobs, ...db.savedJobs, ...db.dismissedJobs].find((j) => j.id === job_id);
      if (!found) {
        return { isError: true, content: [{ type: "text", text: `Job ${job_id} not found.` }] };
      }
      db.scannedJobs = db.scannedJobs.filter((j) => j.id !== job_id);
      db.savedJobs = db.savedJobs.filter((j) => j.id !== job_id);
      db.dismissedJobs = db.dismissedJobs.filter((j) => j.id !== job_id);
      if (notes !== undefined) found.notes = notes;

      switch (status) {
        case "applied":
          found.status = "applied";
          found.appliedDate = new Date().toISOString();
          db.savedJobs.unshift(found);
          break;
        case "saved":
          found.status = "review";
          db.savedJobs.unshift(found);
          break;
        case "dismissed":
          found.status = "dismissed";
          db.dismissedJobs.unshift(found);
          break;
        case "discovered":
          found.status = "discovered";
          db.scannedJobs.unshift(found);
          break;
      }
      writeDb(db);

      return boardResult(db.scannedJobs, db.profile, `Marked "${found.title}" @ ${found.company} as ${status}.`);
    },
  );

  // bulk_status: triage MANY board jobs at once by score/source (server does the selection,
  // so the model doesn't need every job id). Solves "dismiss all roles under 60".
  server.registerTool(
    "bulk_status",
    {
      title: "Bulk Triage",
      description:
        "Triage MANY board jobs at once by score and/or source — e.g. dismiss every scored job under 60. " +
        "Applies `status` to all scanned (board) jobs matching the filters; the server selects them, so you do " +
        "NOT need the individual job ids. `below_score`/`above_score` match SCORED jobs only (use clear_jobs " +
        "for un-evaluated ones). Provide at least one filter. Returns text; call show_board afterward to display.",
      inputSchema: {
        status: z.enum(["saved", "applied", "dismissed", "discovered"]).describe("Status to apply to every match."),
        below_score: z.number().optional().describe("Match scored jobs with matchScore BELOW this (e.g. 60)."),
        above_score: z.number().optional().describe("Match scored jobs with matchScore AT OR ABOVE this."),
        source: z
          .enum(["linkedin", "greenhouse", "lever", "ashby", "workday", "smartrecruiters", "hackernews", "remoteok", "remotive"])
          .optional()
          .describe("Restrict to one source."),
        notes: z.string().optional().describe("Optional note to attach to every matched job."),
      },
    },
    async ({ status, below_score, above_score, source, notes }): Promise<CallToolResult> => {
      if (below_score === undefined && above_score === undefined && source === undefined) {
        return {
          isError: true,
          content: [
            { type: "text", text: "Provide at least one filter (below_score, above_score, or source) so you don't triage the whole board by accident." },
          ],
        };
      }
      const db = readDb();
      const hasScoreFilter = below_score !== undefined || above_score !== undefined;
      const sel = db.scannedJobs.filter((j) => {
        if (hasScoreFilter && j.matchScore < 0) return false; // score filters apply to SCORED jobs only
        if (below_score !== undefined && !(j.matchScore < below_score)) return false;
        if (above_score !== undefined && !(j.matchScore >= above_score)) return false;
        if (source !== undefined && j.sourceTag !== source) return false;
        return true;
      });

      const selIds = new Set(sel.map((j) => j.id));
      db.scannedJobs = db.scannedJobs.filter((j) => !selIds.has(j.id));
      const nowIso = new Date().toISOString();
      for (const job of sel) {
        if (notes !== undefined) job.notes = notes;
        if (status === "applied") {
          job.status = "applied";
          job.appliedDate = nowIso;
          db.savedJobs.unshift(job);
        } else if (status === "saved") {
          job.status = "review";
          db.savedJobs.unshift(job);
        } else if (status === "dismissed") {
          job.status = "dismissed";
          db.dismissedJobs.unshift(job);
        } else {
          job.status = "discovered";
          db.scannedJobs.unshift(job);
        }
      }
      writeDb(db);

      const filterDesc = [
        below_score !== undefined && `score<${below_score}`,
        above_score !== undefined && `score>=${above_score}`,
        source && `source=${source}`,
      ]
        .filter(Boolean)
        .join(", ");
      return {
        content: [{ type: "text", text: `Set ${sel.length} job(s) (${filterDesc}) to ${status}. Call show_board to display the updated board.` }],
      };
    },
  );

  // whats_promising: show the current board ranked, and surface UNSCORED jobs (with
  // ids + descriptions) so Claude can evaluate the backlog. Renders the review UI.
  server.registerTool(
    "whats_promising",
    {
      title: "What's Promising",
      description:
        "List the current job board as text: every scored job (with its id) and any UNSCORED jobs with their " +
        "ids + descriptions so you can evaluate them. To score the unscored ones, call evaluate_jobs with the " +
        "EXACT bracketed ids shown. Use this to review jobs already found (find_jobs only returns brand-new " +
        "ones). To re-score jobs that ALREADY have a score, use rescore_board instead. To DISPLAY the board " +
        "widget to the user, call show_board (this returns text for you to act on).",
      inputSchema: {
        limit: z.number().optional().describe("Max unscored jobs to surface for evaluation (default 15)."),
      },
    },
    async ({ limit }): Promise<CallToolResult> => {
      const db = readDb();
      const ranked = [...db.scannedJobs].sort((a, b) => b.matchScore - a.matchScore);
      const scored = ranked.filter((j) => j.matchScore >= 0);
      const unscored = ranked.filter((j) => j.matchScore < 0);

      let text = `${profileSummary(db.profile)}\n\nBoard: ${scored.length} scored, ${unscored.length} unscored (${db.savedJobs.length} saved, ${db.dismissedJobs.length} dismissed).`;
      if (scored.length) {
        // List ALL scored jobs (with ids) so the model sees the full board in text — needed
        // for reasoning like "dismiss everything under 60" (then use bulk_status).
        text +=
          `\n\nScored (${scored.length}), highest first — "score — title @ company [id]":\n` +
          scored
            .slice(0, 100)
            .map((j) => `${j.matchScore} — ${j.title} @ ${j.company} [${j.id}]`)
            .join("\n");
      }
      if (unscored.length) {
        text +=
          `\n\nUNSCORED — score each 0-100 for the candidate and call evaluate_jobs with one { job_id, score, reason } per job using the EXACT bracketed ids:\n\n` +
          jobEvalBlocks(unscored.slice(0, limit ?? 15));
      }
      text += `\n\nTo show the board widget to the user, call show_board.`;

      return { content: [{ type: "text", text }] };
    },
  );

  // rescore_board: re-evaluate EVERY job already on the board (not just unscored). Maps
  // directly to "rescore the board" — e.g. after the scoring approach changed.
  server.registerTool(
    "rescore_board",
    {
      title: "Re-score Board",
      description:
        "Re-score the WHOLE board from scratch — every job, INCLUDING ones that already have a score. Use this " +
        "when the user asks to 'rescore'/'re-evaluate' the board or after the scoring approach changed. Returns " +
        "all board jobs with their ids + descriptions; call evaluate_jobs with a FRESH { job_id, score, reason } " +
        "for EACH (do not skip already-scored ones), then call show_board. Set include_saved=true to also re-score " +
        "the saved/applied tracker.",
      inputSchema: {
        include_saved: z.boolean().optional().describe("Also re-score the saved/applied tracker jobs (default false)."),
      },
    },
    async ({ include_saved }): Promise<CallToolResult> => {
      const db = readDb();
      const jobs = include_saved ? [...db.scannedJobs, ...db.savedJobs] : db.scannedJobs;
      if (!jobs.length) {
        return { content: [{ type: "text", text: "No jobs on the board to re-score. Run find_jobs first." }] };
      }
      const text =
        `${profileSummary(db.profile)}\n\n` +
        `RE-SCORE all ${jobs.length} job(s) below from scratch — assign a FRESH holistic 0-100 to each for this ` +
        `candidate, ignoring any existing score. Call evaluate_jobs with one { job_id, score, reason } per job ` +
        `using the EXACT bracketed ids, then call show_board.\n\n` +
        jobEvalBlocks(jobs.slice(0, 80));
      return { content: [{ type: "text", text }] };
    },
  );

  // save_profile: Claude extracts the candidate profile from a pasted resume and
  // saves it. The profile drives sourcing (roles/location) and scoring (yoe).
  server.registerTool(
    "save_profile",
    {
      title: "Save Resume Profile",
      description:
        "Extract the candidate's profile from their resume text (which the user pastes in chat) and save it. " +
        "Pull: full name; core technical skills; suggested target roles; preferred/search location; total years " +
        "of professional experience (integer); and pass the resume text as rawText. The profile is used by " +
        "find_jobs (target roles + location) and by scoring (years of experience drives the experience penalty), " +
        "so set yearsOfExperience accurately. Merges with any existing profile.",
      inputSchema: {
        name: z.string().optional().describe("Candidate's full name."),
        skills: z.array(z.string()).optional().describe("Core technical skills."),
        targetRoles: z.array(z.string()).optional().describe("Suggested target job titles."),
        searchLocation: z.string().optional().describe("Preferred location, e.g. 'California' or 'Remote'."),
        prefersRemote: z.boolean().optional().describe("Whether the candidate prefers remote."),
        yearsOfExperience: z.number().optional().describe("Total years of professional experience (integer)."),
        blockedCompanies: z.array(z.string()).optional().describe("Companies to exclude from sourcing."),
        rawText: z.string().optional().describe("The full resume text, stored for reference."),
      },
    },
    async ({ name, skills, targetRoles, searchLocation, prefersRemote, yearsOfExperience, blockedCompanies, rawText }): Promise<CallToolResult> => {
      const db = readDb();
      const base: ResumeProfile =
        db.profile ?? { rawText: "", preferredTypes: ["Full-Time"], minMatchScore: 0, prefersRemote: true, prefersHybrid: false, searchLocation: "" };
      const profile: ResumeProfile = {
        ...base,
        ...(rawText !== undefined ? { rawText } : {}),
        ...(name !== undefined ? { parsedName: name } : {}),
        ...(skills !== undefined ? { parsedSkills: skills } : {}),
        ...(targetRoles !== undefined ? { targetRoles } : {}),
        ...(searchLocation !== undefined ? { searchLocation, preferredLocation: searchLocation } : {}),
        ...(prefersRemote !== undefined ? { prefersRemote } : {}),
        ...(yearsOfExperience !== undefined ? { yearsOfExperience } : {}),
        ...(blockedCompanies !== undefined ? { blockedCompanies } : {}),
      };
      db.profile = profile;
      writeDb(db);

      // Propose a ready-to-run starter search derived from the resume; these defaults also
      // carry forward into bare find_jobs calls (via searchInputs).
      const starter: Record<string, string> = { query: profile.targetRoles?.[0] || "Software Engineer" };
      if (profile.searchLocation) starter.location = profile.searchLocation;
      const level = yoeToLinkedInLevel(profile.yearsOfExperience ?? 0);
      if (level) starter.experience_level = level;
      if (profile.prefersRemote) starter.remote = "remote";
      const starterStr = Object.entries(starter)
        .map(([k, v]) => `${k}="${v}"`)
        .join(", ");

      const text =
        `Saved profile${profile.parsedName ? ` for ${profile.parsedName}` : ""}: ` +
        `${profile.targetRoles?.length ? profile.targetRoles.join(", ") : "(no roles)"} · ` +
        `${profile.searchLocation || "(no location)"} · ${profile.yearsOfExperience ?? 0}y exp` +
        `${profile.parsedSkills?.length ? ` · ${profile.parsedSkills.length} skills` : ""}.\n` +
        `Scoring will use ${profile.yearsOfExperience ?? 0} years of experience, and find_jobs inherits these defaults.\n\n` +
        `Suggested starter search — offer to run find_jobs with ${starterStr}, then evaluate the results.`;
      return { content: [{ type: "text", text }] };
    },
  );

  // review_saved: the tracker — jobs you've saved/applied to, with status + notes.
  server.registerTool(
    "review_saved",
    {
      title: "Review Saved Jobs",
      description:
        "List the tracker as text: jobs marked saved (interested) or applied, with their status, score, and " +
        "notes. Use this to see what you're tracking or have applied to. To DISPLAY the tracker widget, call " +
        "show_board with view='saved'.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      const db = readDb();
      const rank = (s: string) => (s === "applied" ? 0 : s === "interviewing" ? 1 : s === "offered" ? 2 : 3);
      const jobs = [...db.savedJobs].sort((a, b) => rank(a.status) - rank(b.status) || b.matchScore - a.matchScore);
      const applied = jobs.filter((j) => j.status === "applied").length;
      const text = jobs.length
        ? `Tracking ${jobs.length} job(s) (${applied} applied):\n` +
          jobs
            .map((j) => `- [${j.status}] ${j.title} @ ${j.company}${j.matchScore >= 0 ? ` (${j.matchScore})` : ""}${j.notes ? ` — ${j.notes}` : ""}`)
            .join("\n")
        : "No saved jobs yet. Mark jobs as 'saved' or 'applied' (triage buttons or set_status) to track them here.";
      return { content: [{ type: "text", text: `${text}\n\nTo display the tracker, call show_board with view="saved".` }] };
    },
  );

  // clear_jobs: declutter the review board. Removes scanned jobs only; never touches
  // saved/applied (the tracker) or dismissed (so dismissed jobs still won't be re-sourced).
  server.registerTool(
    "clear_jobs",
    {
      title: "Clear Jobs",
      description:
        "Clear jobs from the review board. which='unscored' (default) removes only the not-yet-evaluated " +
        "leftovers; which='all' clears the whole board. Saved/applied jobs (the tracker) and dismissed jobs " +
        "are NOT affected — dismissed jobs still won't be re-sourced. Returns text; call show_board to display.",
      inputSchema: {
        which: z
          .enum(["unscored", "all"])
          .optional()
          .describe("'unscored' (default) clears un-evaluated jobs; 'all' clears the whole board."),
      },
    },
    async ({ which }): Promise<CallToolResult> => {
      const db = readDb();
      const before = db.scannedJobs.length;
      const mode = which ?? "unscored";
      db.scannedJobs = mode === "all" ? [] : db.scannedJobs.filter((j) => j.matchScore >= 0);
      const removed = before - db.scannedJobs.length;
      writeDb(db);
      const note =
        `Cleared ${removed} ${mode === "all" ? "" : "unscored "}job(s) from the board; ${db.scannedJobs.length} remain. ` +
        `Saved/applied and dismissed jobs were untouched.`;
      return { content: [{ type: "text", text: `${note} Call show_board to display the board.` }] };
    },
  );

  // show_board: the ONE tool that renders the widget. Call it once at the end of a request
  // (after find/evaluate/triage/clear) to display the result — keeps multi-step requests to a
  // single widget instead of one per tool call.
  registerAppTool(
    server,
    "show_board",
    {
      title: "Show Board",
      description:
        "Display the job board (or the saved/applied tracker) as an interactive widget. Call this ONCE, at the " +
        "end of a request, after doing the work (find_jobs/evaluate_jobs/bulk_status/clear_jobs/whats_promising " +
        "are text-only and do NOT render). view='board' (default) shows the ranked board; view='saved' shows the " +
        "tracker.",
      inputSchema: {
        view: z.enum(["board", "saved"]).optional().describe("'board' (default) = the ranked board; 'saved' = the applied/saved tracker."),
      },
      outputSchema: FIND_JOBS_OUTPUT,
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ view }): Promise<CallToolResult> => {
      const db = readDb();
      if (view === "saved") {
        const rank = (s: string) => (s === "applied" ? 0 : s === "interviewing" ? 1 : s === "offered" ? 2 : 3);
        const jobs = [...db.savedJobs].sort((a, b) => rank(a.status) - rank(b.status) || b.matchScore - a.matchScore);
        return {
          content: [{ type: "text", text: jobs.length ? `Showing ${jobs.length} tracked job(s).` : "No saved/applied jobs yet." }],
          structuredContent: {
            jobs: jobs.map(slimJob),
            count: jobs.length,
            scored: jobs.some((j) => j.matchScore >= 0),
            profile: slimProfile(db.profile),
            view: "saved",
          },
        };
      }
      const note = db.scannedJobs.length ? `Showing the board (${db.scannedJobs.length} jobs).` : "The board is empty — run find_jobs.";
      return boardResult(db.scannedJobs, db.profile, note);
    },
  );

  // The bundled review UI the host renders in a sandboxed iframe.
  registerAppResource(
    server,
    "Job Search Review",
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(path.join(DIST_DIR, "mcp-app.html"), "utf-8");
      return {
        contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    },
  );

  return server;
}
