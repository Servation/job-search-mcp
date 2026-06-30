/**
 * Deterministic match scoring, ported VERBATIM from the original job-search-agent
 * (server/llm.ts computeMatchScore + its constants). This is the determinism
 * anchor: given the same facts + years-of-experience it always yields the same
 * 0..97 score and a self-explaining reason. Claude supplies the facts; the server
 * owns the arithmetic.
 */
import type { Job, JobFacts } from "./types.js";

const SCORE_PENALTY_PER_YEAR = 7; // points off per year of experience short
const SCORE_MAX_EXP_PENALTY = 21; // cap on the experience penalty
const SCORE_MUSTHAVE_CAP = 55; // ceiling when an explicit must-have skill is missing
const SCORE_SPECIALIST_CAP = 40; // ceiling when a required formal credential is missing
const SCORE_CEIL = 97; // no posting is a literal 100% match

/**
 * Deterministically computes a 0-100 match score from extracted facts.
 * Reproducible (no LLM arithmetic), never negative or saturated, and self-explaining.
 */
export function computeMatchScore(f: any, yoe: number): { score: number; reason: string } {
  const matched = Array.isArray(f?.matched) ? f.matched : [];
  const missing = Array.isArray(f?.missing) ? f.missing : [];
  const core = Array.isArray(f?.coreRequirements) ? f.coreRequirements : [];
  const matchedN = matched.length;
  const totalN = Math.max(core.length, matchedN + missing.length, 1);
  const base = Math.round((100 * matchedN) / totalN);

  const expGap = Math.max(0, (Number(f?.requiredYears) || 0) - yoe);
  const expPenalty = Math.min(expGap * SCORE_PENALTY_PER_YEAR, SCORE_MAX_EXP_PENALTY);

  let score = base - expPenalty;
  if (f?.mustHaveMissing) score = Math.min(score, SCORE_MUSTHAVE_CAP);
  if (f?.specialistGapMissing) score = Math.min(score, SCORE_SPECIALIST_CAP);
  score = Math.max(0, Math.min(SCORE_CEIL, score));

  const reason =
    `Met ${matchedN}/${totalN} core` +
    (missing.length ? ` (missing: ${missing.slice(0, 3).join(", ")})` : "") +
    "." +
    (expGap > 0 ? ` Exp: needs ${f.requiredYears}y, has ${yoe}y (-${expPenalty}).` : "") +
    (f?.mustHaveMissing ? " Must-have gap." : "") +
    (f?.specialistGapMissing ? " Specialist gap." : "");

  return { score, reason };
}

/** Apply Claude's extracted facts to a job: score it and copy through the extracted fields. */
export function applyFactsToJob(job: Job, facts: JobFacts, yoe: number): Job {
  const { score, reason } = computeMatchScore(facts, yoe);
  const updated: Job = {
    ...job,
    matchScore: score,
    matchReason: reason,
    skillsRequired: facts.coreRequirements,
    industry: facts.industry ?? job.industry,
    experienceLevel: facts.experienceLevel ?? job.experienceLevel,
    salaryNum: facts.salaryNum ?? job.salaryNum,
  };
  if (!updated.salary && facts.salaryNum) {
    updated.salary = `$${Math.round(facts.salaryNum / 1000)}k`;
  }
  return updated;
}

export interface HolisticEval {
  score: number;
  reason: string;
  experienceLevel?: "Junior" | "Mid" | "Senior" | "Lead";
  industry?: string;
  salaryNum?: number;
  skills?: string[];
}

/**
 * ACTIVE scoring path: apply Claude's HOLISTIC score + reason to a job (clamped 0-100).
 * The host model (Claude) judges fit directly — it's far better calibrated than the
 * local LLMs the deterministic computeMatchScore above was built to guard against.
 * computeMatchScore/applyFactsToJob are kept as the deterministic fallback (rewire
 * evaluate_jobs to them if ever scoring with a weaker model that over-ranks).
 */
export function applyHolisticScore(job: Job, ev: HolisticEval): Job {
  const score = Math.max(0, Math.min(100, Math.round(ev.score)));
  const updated: Job = { ...job, matchScore: score, matchReason: ev.reason };
  if (ev.experienceLevel !== undefined) updated.experienceLevel = ev.experienceLevel;
  if (ev.industry !== undefined) updated.industry = ev.industry;
  if (ev.salaryNum !== undefined) {
    updated.salaryNum = ev.salaryNum;
    if (!updated.salary) updated.salary = `$${Math.round(ev.salaryNum / 1000)}k`;
  }
  if (ev.skills !== undefined) updated.skillsRequired = ev.skills;
  return updated;
}
