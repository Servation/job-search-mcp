/**
 * Source-health canary. Runs each of the 9 scrapers with a generic software-engineer
 * query and prints how many postings each returned, so the maintainer finds out a source
 * has gone dark (endpoint moved, markup changed, IP/UA blocked) BEFORE users hit an
 * empty board. Every scraper swallows its own errors and returns [], so "0" is the signal.
 *
 * Read-only: it calls the fetchers directly and never touches the job store.
 *
 * Run:  npm run canary        (exits non-zero if any source returned 0, for CI/cron use)
 */
import { globalState } from "../config.js";
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
  type RawCommunityJob,
} from "../sourcing.js";

const keywords = ["software", "engineer", "developer"];
const skills: string[] = [];
const targetRoles = ["Software Engineer"];
const location = "";
const prefersRemote = true;
const yoe = 0;

const sources: { name: string; run: () => Promise<RawCommunityJob[]> }[] = [
  { name: "linkedin", run: () => fetchLinkedInJobs({ keyword: "software engineer", location, targetRoles, yearsOfExperience: yoe, prefersRemote, limit: 10 }) },
  { name: "greenhouse", run: () => fetchGreenhouseJobs(globalState.cachedGreenhouseSlugs, keywords, targetRoles, location, prefersRemote, yoe) },
  { name: "lever", run: () => fetchLeverJobs(globalState.cachedLeverSlugs, keywords, targetRoles, location, prefersRemote, yoe) },
  { name: "ashby", run: () => fetchAshbyJobs(globalState.cachedAshbySlugs, keywords, targetRoles, location, prefersRemote, yoe) },
  { name: "workday", run: () => fetchWorkdayJobs(globalState.cachedWorkdayDirectory, keywords, targetRoles, location, prefersRemote, yoe) },
  { name: "smartrecruiters", run: () => fetchSmartRecruitersJobs(globalState.cachedSmartRecruitersDirectory, keywords, targetRoles, location, prefersRemote, yoe) },
  { name: "hackernews", run: () => fetchHackerNewsJobs(keywords, skills, targetRoles, location, prefersRemote, yoe) },
  { name: "remoteok", run: () => fetchRemoteOKJobs(keywords, skills, targetRoles, location, prefersRemote, yoe) },
  { name: "remotive", run: () => fetchRemotiveJobs(keywords, skills, targetRoles, location, prefersRemote, yoe) },
];

async function main(): Promise<void> {
  await updateCompanyDirectoriesFromRegistry().catch(() => {}); // best-effort, mirrors find_jobs
  console.error('Source health check (generic "software engineer" query):\n');

  const results = await Promise.allSettled(sources.map((s) => s.run()));
  let dead = 0;
  results.forEach((r, i) => {
    const n = r.status === "fulfilled" ? r.value.length : 0;
    if (n === 0) dead++;
    const mark = n === 0 ? "DEAD" : "ok  ";
    console.error(`  [${mark}] ${sources[i].name.padEnd(16)} ${n}`);
  });

  console.error(`\n${sources.length - dead}/${sources.length} sources returned postings.`);
  if (dead > 0) {
    console.error(`WARNING: ${dead} source(s) returned 0 — investigate (endpoint/markup drift, rate limit, or genuinely empty).`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
