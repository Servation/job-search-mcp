/**
 * Core data model for job-search-mcp.
 *
 * Ported from the original job-search-agent (src/types.ts), minus the LLMConfig
 * settings: there is no external LLM in this MCP App. Claude (the host model)
 * supplies the extraction `facts`; the server scores deterministically.
 */

export type JobTypeType = "Full-Time" | "Contract" | "Part-Time";
export type JobStatusType =
  | "discovered"
  | "applied"
  | "review"
  | "interviewing"
  | "offered"
  | "rejected"
  | "dismissed";

export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  salary?: string;
  type: JobTypeType;
  isW2: boolean; // true = W2, false = 1099/C2C/unspecified
  description: string;
  url: string;
  postedAt: string; // ISO string or relative time (e.g. "4 hours ago")
  matchScore: number; // 0..100; -1 = not yet evaluated
  matchReason?: string;
  isDuplicate: boolean;
  status: JobStatusType;
  notes?: string;
  appliedDate?: string;
  scannedAt: string; // ISO string of when the job was found
  skillsRequired?: string[];
  industry?: string;
  experienceLevel?: "Junior" | "Mid" | "Senior" | "Lead";
  isRemote?: boolean;
  salaryNum?: number;
  isUrlVerified?: boolean;
  sourceTag?: string;
  isFullDescriptionFetched?: boolean;
  applicants?: number; // LinkedIn applicant count, when known
}

/**
 * The candidate profile that drives sourcing (search terms/location) and scoring
 * (years of experience). Claude extracts this from the resume and saves it.
 */
export interface ResumeProfile {
  rawText: string;
  parsedName?: string;
  parsedSkills?: string[];
  targetRoles?: string[];
  preferredLocation?: string;
  preferredTypes: JobTypeType[];
  minMatchScore: number;
  prefersRemote: boolean;
  prefersHybrid: boolean;
  prefersOnSite?: boolean;
  searchLocation: string;
  searchDistance?: string;
  maxDiscoveredJobs?: number;
  limitCompanyMatches?: boolean;
  maxMatchesPerCompany?: number;
  yearsOfExperience?: number; // candidate's total professional years (0 = not set)
  blockedCompanies?: string[];
}

/**
 * The extraction "facts" contract Claude fills per job. This is the exact shape
 * the original Gemini/LLM extraction prompt produced; it feeds computeMatchScore.
 */
export interface JobFacts {
  coreRequirements: string[];
  matched: string[];
  missing: string[];
  mustHaveMissing: boolean;
  requiredYears: number;
  specialistGapMissing: boolean;
  experienceLevel?: "Junior" | "Mid" | "Senior" | "Lead";
  industry?: string;
  salaryNum?: number;
}

export interface WorkdayCompany {
  name: string;
  tenant: string;
  site: string;
  host?: string;
  consecutiveFailures?: number;
}

export interface SmartRecruitersCompany {
  name: string;
  slug: string;
}
