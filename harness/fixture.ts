/**
 * Synthetic board data for the host harness, plus a tiny in-memory store that mimics the
 * server's triage semantics.
 *
 * The companies and postings here are invented. That is deliberate: the harness must be
 * committable and shareable, so it can never carry a snapshot of a real user's job store
 * (which contains their name, target roles and the roles they are actually tracking).
 *
 * The rows are chosen to exercise the widget's branches rather than to look realistic:
 * every score band, an unscored job, a job with no matchReason (so the card falls back to
 * the description), and jobs missing each of the optional fields.
 */

/** Mirrors the server's slimJob output, which is what the widget reads. */
export interface HarnessJob {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  postedAt: string;
  status: string;
  matchScore: number; // -1 = not yet evaluated
  sourceTag?: string;
  salary?: string;
  isRemote?: boolean;
  matchReason?: string;
  experienceLevel?: string;
  skillsRequired?: string[];
  applicants?: number;
}

export const PROFILE = {
  parsedName: "Sam Rivera",
  parsedSkills: ["TypeScript", "Go", "Postgres", "Kubernetes"],
  targetRoles: ["Backend Engineer", "Full Stack Engineer", "Platform Engineer"],
  searchLocation: "Remote US",
  prefersRemote: true,
  yearsOfExperience: 5,
};

const DESC =
  "We are building the data platform that powers our product. You will own services end to " +
  "end, from schema design through rollout and on-call, and work closely with the teams " +
  "consuming your APIs. We care more about judgement than about any particular language.";

/**
 * Score bands the widget colours differently: >= 75 good, >= 50 warn, >= 0 bad, -1 unscored.
 * Keep at least one job on each side of every boundary so a regression in scoreColor shows up.
 */
const SEED: HarnessJob[] = [
  {
    id: "gh_001",
    title: "Senior Backend Engineer, Payments Platform",
    company: "Northwind Systems",
    location: "Remote US",
    url: "https://example.com/jobs/gh_001",
    description: DESC,
    postedAt: "2026-08-18T00:00:00.000Z",
    status: "discovered",
    matchScore: 92,
    matchReason: "Payments plus Go and Postgres is a direct hit on the last three years of his work.",
    sourceTag: "greenhouse",
    salary: "$180k - $220k",
    isRemote: true,
    experienceLevel: "Senior",
    skillsRequired: ["Go", "Postgres", "Kubernetes"],
    applicants: 12,
  },
  {
    id: "gh_002",
    title: "Staff Engineer, Developer Platform",
    company: "Meridian Labs",
    location: "San Francisco, CA",
    url: "https://example.com/jobs/gh_002",
    description: DESC,
    postedAt: "2026-08-17T00:00:00.000Z",
    status: "discovered",
    matchScore: 75, // exactly on the good/warn boundary
    matchReason: "Platform work lines up, but Staff is a level above where he is now.",
    sourceTag: "lever",
    isRemote: false,
    experienceLevel: "Staff",
    skillsRequired: ["Kubernetes", "Terraform"],
  },
  {
    id: "ash_003",
    title: "Full Stack Engineer",
    company: "Alcove",
    location: "Remote US",
    url: "https://example.com/jobs/ash_003",
    description: DESC,
    postedAt: "2026-08-16T00:00:00.000Z",
    status: "discovered",
    matchScore: 50, // exactly on the warn/bad boundary
    matchReason: "Right level and remote, but the stack is Rails and he has not shipped Ruby.",
    sourceTag: "ashby",
    salary: "$150k - $175k",
    isRemote: true,
    experienceLevel: "Mid",
    applicants: 240,
  },
  {
    id: "wd_004",
    title: "Software Engineer II, Internal Tools and Workflow Automation Platform Group",
    company: "Continental Aggregate Holdings Incorporated",
    location: "Austin, TX",
    url: "https://example.com/jobs/wd_004",
    description: DESC,
    postedAt: "2026-08-15T00:00:00.000Z",
    status: "discovered",
    matchScore: 31,
    matchReason: "Junior of his level and on-site in a city he did not list.",
    sourceTag: "workday",
    // No salary, isRemote, skills or applicants: the card must not render empty separators.
  },
  {
    id: "hn_005",
    title: "Backend Engineer (Rust)",
    company: "Tessellate",
    location: "Remote (US/EU)",
    url: "https://example.com/jobs/hn_005",
    description: DESC,
    postedAt: "2026-08-14T00:00:00.000Z",
    status: "discovered",
    matchScore: -1, // unscored, and no matchReason: card falls back to the description
    sourceTag: "hackernews",
    isRemote: true,
  },
  {
    id: "sr_006",
    title: "Platform Engineer",
    company: "Halden",
    location: "Remote US",
    url: "https://example.com/jobs/sr_006",
    description: DESC,
    postedAt: "2026-08-12T00:00:00.000Z",
    status: "applied",
    matchScore: 81,
    matchReason: "Strong infrastructure fit; already applied.",
    sourceTag: "smartrecruiters",
    salary: "$170k - $200k",
    isRemote: true,
    experienceLevel: "Senior",
  },
];

/**
 * In-memory stand-in for the server's job store. It splits jobs the same way the real
 * server does (a board of untriaged jobs, a tracker of saved/applied ones) so that
 * triaging in the harness behaves like triaging for real, including after the widget's
 * post-mount refresh re-reads show_board.
 */
export class HarnessStore {
  private jobs: HarnessJob[] = SEED.map((j) => ({ ...j }));

  private board(): HarnessJob[] {
    return this.jobs.filter((j) => j.status === "discovered");
  }

  private saved(): HarnessJob[] {
    const rank = (s: string) => (s === "applied" ? 0 : s === "interviewing" ? 1 : s === "offered" ? 2 : 3);
    return this.jobs
      .filter((j) => ["applied", "interviewing", "offered", "review"].includes(j.status))
      .sort((a, b) => rank(a.status) - rank(b.status) || b.matchScore - a.matchScore);
  }

  /** Shape a tool result exactly as the server's boardResult/show_board does. */
  result(view: "board" | "saved") {
    const jobs = view === "saved" ? this.saved() : this.board();
    const text =
      view === "saved"
        ? jobs.length
          ? `Showing ${jobs.length} tracked job(s).`
          : "No saved/applied jobs yet."
        : jobs.length
          ? `Showing the board (${jobs.length} jobs).`
          : "The board is empty - run find_jobs.";
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: {
        jobs,
        count: jobs.length,
        scored: jobs.some((j) => j.matchScore >= 0),
        profile: PROFILE,
        view,
      },
    };
  }

  /** Mirrors the server's set_status: 'saved' lands as 'review', dismissed drops off the board. */
  setStatus(jobId: string, status: string): boolean {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return false;
    job.status = status === "saved" ? "review" : status;
    return true;
  }
}
