/**
 * Deterministic job sourcing, ported from the original job-search-agent
 * (server/sourcing.ts). All public job-board APIs; no API keys. Trimmed to the
 * eight scrapers find_jobs uses plus the remote slug-registry updater and the
 * Workday dynamic-company failure tracking. All console.* routed to stderr so the
 * stdio JSON-RPC stream on stdout stays clean.
 */
import type { WorkdayCompany, SmartRecruitersCompany } from "./types.js";
import { globalState, addRefinerLog } from "./config.js";
import { readDb, writeDb } from "./db.js";
import {
  communitySlugToName,
  matchesKeywords,
  isBlocklistedRole,
  matchesLocation,
  stripHtmlCommunity,
} from "./utils.js";

export interface RawCommunityJob {
  title: string;
  company: string;
  location: string;
  description: string;
  url: string;
  applyUrl?: string;
  postedAt: string;
  type: string;
  salary?: string;
  isRemote: boolean;
  source: "greenhouse" | "lever" | "workday" | "smartrecruiters" | "ashby" | "remoteok" | "websearch" | "remotive" | "hackernews" | "linkedin";
}

const LINKEDIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Refresh the cached company directories from the remote registry (throttled to 12h). */
export async function updateCompanyDirectoriesFromRegistry(): Promise<void> {
  const now = Date.now();
  const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

  if (now - globalState.lastRegistryFetchTime < TWELVE_HOURS_MS && globalState.lastRegistryFetchTime !== 0) {
    return; // memory cache is fresh
  }

  console.error("[Registry] Checking for company directory updates from remote registry...");
  try {
    const response = await fetch("https://raw.githubusercontent.com/Servation/job-search-agent-slugs/main/slugs.json", {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    if (response.ok) {
      const data = (await response.json()) as any;
      if (data) {
        if (Array.isArray(data.greenhouse)) globalState.cachedGreenhouseSlugs = data.greenhouse;
        if (Array.isArray(data.lever)) globalState.cachedLeverSlugs = data.lever;
        if (Array.isArray(data.ashby)) globalState.cachedAshbySlugs = data.ashby;
        if (Array.isArray(data.workday)) globalState.cachedWorkdayDirectory = data.workday;
        if (Array.isArray(data.smartrecruiters)) globalState.cachedSmartRecruitersDirectory = data.smartrecruiters;
        if (data.templates) {
          if (data.templates.workdaySearch) globalState.templates.workdaySearch = data.templates.workdaySearch;
          if (data.templates.workdayDetails) globalState.templates.workdayDetails = data.templates.workdayDetails;
          if (data.templates.smartrecruitersPostings) globalState.templates.smartrecruitersPostings = data.templates.smartrecruitersPostings;
          if (data.templates.smartrecruitersDetails) globalState.templates.smartrecruitersDetails = data.templates.smartrecruitersDetails;
        }
        globalState.lastRegistryFetchTime = now;
        console.error("[Registry] Updated company directories from remote registry.");
        return;
      }
    }
  } catch (err: any) {
    console.error("[Registry] Remote registry update failed (using static lists):", err?.message);
  }
  // Set the timestamp even on failure to avoid hammering the request within a run.
  globalState.lastRegistryFetchTime = now;
}

/** Run an async map in batches with a brief pause between batches. */
async function batchPromises<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R[]>,
  batchSize: number,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchRes = await Promise.allSettled(batch.map((item) => fn(item)));
    for (const res of batchRes) {
      if (res.status === "fulfilled") results.push(...res.value);
    }
    if (i + batchSize < items.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return results;
}

/** Track per-company Workday fetch failures in the dynamic directory; prune after 5. */
function applyDynamicCompanyFailures(failures: { company: WorkdayCompany; failed: boolean }[]) {
  if (failures.length === 0) return;

  const db = readDb();
  if (!db.workdayDirectory) return;

  const tenantIndexMap = new Map<string, number>();
  for (let i = 0; i < db.workdayDirectory.length; i++) {
    tenantIndexMap.set(db.workdayDirectory[i].tenant.toLowerCase(), i);
  }

  let dbWasModified = false;

  for (const { company, failed } of failures) {
    const idx = tenantIndexMap.get(company.tenant.toLowerCase());
    if (idx === undefined || idx === -1) continue;

    const dynamicCompany = db.workdayDirectory[idx];
    if (!dynamicCompany) continue;

    if (failed) {
      dynamicCompany.consecutiveFailures = (dynamicCompany.consecutiveFailures || 0) + 1;
      if (dynamicCompany.consecutiveFailures >= 5) {
        addRefinerLog(`Removed broken company board: ${dynamicCompany.name}.`);
        (db.workdayDirectory as any)[idx] = null;
      }
      dbWasModified = true;
    } else if (dynamicCompany.consecutiveFailures && dynamicCompany.consecutiveFailures > 0) {
      dynamicCompany.consecutiveFailures = 0;
      dbWasModified = true;
    }
  }

  if (dbWasModified) {
    db.workdayDirectory = db.workdayDirectory.filter(Boolean);
    writeDb(db);
  }
}

export async function fetchGreenhouseJobs(
  slugs: readonly string[],
  keywords: string[],
  targetRoles: string[],
  searchLocation: string,
  prefersRemote: boolean,
  yearsOfExperience: number = 0,
): Promise<RawCommunityJob[]> {
  return batchPromises(
    slugs,
    async (slug): Promise<RawCommunityJob[]> => {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`, {
          signal: ctrl.signal,
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        clearTimeout(tid);
        if (!res.ok) return [];
        const data = (await res.json()) as any;
        const name = communitySlugToName(slug);
        return ((data.jobs as any[]) || [])
          .filter((j) => {
            const title = j.title || "";
            const locName = j.location?.name || "";
            return (
              matchesKeywords(title, keywords) &&
              !isBlocklistedRole(title, targetRoles, yearsOfExperience) &&
              matchesLocation(locName, searchLocation, prefersRemote)
            );
          })
          .map((j) => ({
            title: j.title || "Unknown Role",
            company: name,
            location: j.location?.name || "Not specified",
            description: stripHtmlCommunity(j.content || "").slice(0, 15000),
            url: j.absolute_url || "",
            postedAt: j.updated_at || new Date().toISOString(),
            type: "Full-Time",
            isRemote: (j.location?.name || "").toLowerCase().includes("remote"),
            source: "greenhouse" as const,
          }));
      } catch {
        clearTimeout(tid);
        return [];
      }
    },
    8,
  );
}

export async function fetchLeverJobs(
  slugs: readonly string[],
  keywords: string[],
  targetRoles: string[],
  searchLocation: string,
  prefersRemote: boolean,
  yearsOfExperience: number = 0,
): Promise<RawCommunityJob[]> {
  return batchPromises(
    slugs,
    async (slug): Promise<RawCommunityJob[]> => {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`, {
          signal: ctrl.signal,
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        clearTimeout(tid);
        if (!res.ok) return [];
        const jobs = (await res.json()) as any;
        if (!Array.isArray(jobs)) return [];
        const name = communitySlugToName(slug);
        return jobs
          .filter((j) => {
            const title = j.text || "";
            const loc = j.categories?.location || j.location || "";
            return (
              matchesKeywords(title, keywords) &&
              !isBlocklistedRole(title, targetRoles, yearsOfExperience) &&
              matchesLocation(loc, searchLocation, prefersRemote)
            );
          })
          .map((j) => {
            const sr = j.salaryRange;
            const salary =
              sr?.min && sr?.max
                ? `${sr.currency || "USD"} ${Math.round(sr.min / 1000)}k–${Math.round(sr.max / 1000)}k`
                : undefined;
            const loc = j.categories?.location || j.location || "";
            return {
              title: j.text || "Unknown Role",
              company: name,
              location: loc || "Not specified",
              description: (j.descriptionPlain || stripHtmlCommunity(j.description || "")).slice(0, 15000),
              url: j.hostedUrl || j.applyUrl || "",
              applyUrl: j.applyUrl,
              postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : new Date().toISOString(),
              type: j.categories?.commitment || "Full-Time",
              salary,
              isRemote: j.workplaceType === "remote" || loc.toLowerCase().includes("remote"),
              source: "lever" as const,
            };
          });
      } catch {
        clearTimeout(tid);
        return [];
      }
    },
    2,
  );
}

export async function fetchAshbyJobs(
  slugs: readonly string[],
  keywords: string[],
  targetRoles: string[],
  searchLocation: string,
  prefersRemote: boolean,
  yearsOfExperience: number = 0,
): Promise<RawCommunityJob[]> {
  return batchPromises(
    slugs,
    async (slug): Promise<RawCommunityJob[]> => {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 15000);
      try {
        const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`, {
          signal: ctrl.signal,
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        clearTimeout(tid);
        if (!res.ok) return [];
        const data = (await res.json()) as any;
        const name = communitySlugToName(slug);

        return ((data.jobs as any[]) || [])
          .filter((j) => {
            if (!j.isListed) return false;
            const title = j.title || "";
            const locName = j.location || "";
            return (
              matchesKeywords(title, keywords) &&
              !isBlocklistedRole(title, targetRoles, yearsOfExperience) &&
              matchesLocation(locName, searchLocation, prefersRemote)
            );
          })
          .map((j) => {
            const isRemote = j.workplaceType === "Remote" || (j.location || "").toLowerCase().includes("remote");
            const desc = (j.descriptionPlain || (j.descriptionHtml ? stripHtmlCommunity(j.descriptionHtml) : "")).slice(0, 15000);

            let salaryStr = "Not specified";
            if (j.compensation) {
              if (j.compensation.summary) {
                salaryStr = j.compensation.summary;
              } else if (j.compensation.minValue && j.compensation.maxValue) {
                const cur = j.compensation.currencyCode || "USD";
                salaryStr = `${cur} ${Math.round(j.compensation.minValue / 1000)}k–${Math.round(j.compensation.maxValue / 1000)}k`;
              }
            }

            return {
              title: j.title || "Unknown Role",
              company: name,
              location: j.location || "Remote",
              description: desc,
              url: `https://jobs.ashbyhq.com/${slug}/${j.id}`,
              postedAt: new Date().toISOString(),
              type: j.employmentType === "Contract" ? "Contract" : j.employmentType === "PartTime" ? "Part-Time" : "Full-Time",
              isRemote,
              salary: salaryStr,
              source: "ashby" as const,
            };
          });
      } catch {
        clearTimeout(tid);
        return [];
      }
    },
    4,
  );
}

export async function fetchWorkdayJobs(
  companies: WorkdayCompany[],
  keywords: string[],
  targetRoles: string[],
  searchLocation: string,
  prefersRemote: boolean,
  yearsOfExperience: number = 0,
): Promise<RawCommunityJob[]> {
  const initialDb = readDb();
  const dynamicCompanies = initialDb.workdayDirectory || [];
  const mergedCompanies = [...companies];
  const seenTenants = new Set(mergedCompanies.map((c) => c.tenant.toLowerCase()));

  for (const c of dynamicCompanies) {
    if (!seenTenants.has(c.tenant.toLowerCase())) {
      mergedCompanies.push(c);
      seenTenants.add(c.tenant.toLowerCase());
    }
  }

  const failuresQueue: { company: WorkdayCompany; failed: boolean }[] = [];

  const results = await batchPromises(
    mergedCompanies,
    async (company): Promise<RawCommunityJob[]> => {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 12000);
      const host = company.host || `${company.tenant}.myworkdayjobs.com`;

      try {
        const queryText = targetRoles.length > 0 ? targetRoles[0] : "Software Engineer";
        const searchUrl = `https://${host}/wday/cxs/${company.tenant}/${company.site}/jobs`;

        const response = await fetch(searchUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Origin: `https://${host}`,
            Referer: `https://${host}/en-US/${company.site}/`,
          },
          body: JSON.stringify({ searchText: queryText, limit: 20, offset: 0, appliedFacets: {} }),
          signal: ctrl.signal,
        });

        clearTimeout(tid);

        if (!response.ok) {
          console.error(`[Workday] Fetch failed for ${company.name} (${host}): HTTP ${response.status}`);
          failuresQueue.push({ company, failed: true });
          return [];
        }

        const data = (await response.json()) as any;
        failuresQueue.push({ company, failed: false });
        const postings = (data.jobPostings || []) as any[];

        const matchingPostings = postings.filter((p) => {
          const title = p.title || "";
          return matchesKeywords(title, keywords) && !isBlocklistedRole(title, targetRoles, yearsOfExperience);
        });

        const detailedJobs = await Promise.all(
          matchingPostings.map(async (p): Promise<RawCommunityJob | null> => {
            const pathParts = (p.externalPath || "").split("/");
            const jobId = pathParts[pathParts.length - 1];
            if (!jobId) return null;

            const detailUrl = `https://${host}/wday/cxs/${company.tenant}/${company.site}/job/${jobId}`;
            const dCtrl = new AbortController();
            const dTid = setTimeout(() => dCtrl.abort(), 6000);

            try {
              const dRes = await fetch(detailUrl, {
                headers: {
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                  Origin: `https://${host}`,
                  Referer: `https://${host}/en-US/${company.site}/`,
                },
                signal: dCtrl.signal,
              });
              clearTimeout(dTid);

              if (dRes.ok) {
                const dData = (await dRes.json()) as any;
                const desc = stripHtmlCommunity(dData.jobPostingInfo?.jobDescription || "").slice(0, 15000);
                const loc = p.locationsText || "Specified on site";
                if (!matchesLocation(loc, searchLocation, prefersRemote)) return null;
                return {
                  title: p.title,
                  company: company.name,
                  location: loc,
                  description: desc,
                  url: `https://${host}/en-US/${company.site}${p.externalPath}`,
                  postedAt: p.postedOn || new Date().toISOString(),
                  type: "Full-Time",
                  isRemote: loc.toLowerCase().includes("remote"),
                  source: "workday" as const,
                };
              }
            } catch (err: any) {
              clearTimeout(dTid);
              console.error(`[Workday] Details failed for ${company.name} job ${jobId}:`, err?.message);
            }

            const loc = p.locationsText || "Specified on site";
            if (!matchesLocation(loc, searchLocation, prefersRemote)) return null;
            return {
              title: p.title,
              company: company.name,
              location: loc,
              description: "Position details available on application site.",
              url: `https://${host}/en-US/${company.site}${p.externalPath}`,
              postedAt: p.postedOn || new Date().toISOString(),
              type: "Full-Time",
              isRemote: loc.toLowerCase().includes("remote"),
              source: "workday" as const,
            };
          }),
        );

        return detailedJobs.filter(Boolean) as RawCommunityJob[];
      } catch (err: any) {
        clearTimeout(tid);
        console.error(`[Workday] Failed fetching ${company.name} jobs:`, err?.message);
        failuresQueue.push({ company, failed: true });
        return [];
      }
    },
    3,
  );

  applyDynamicCompanyFailures(failuresQueue);
  return results;
}

export async function fetchSmartRecruitersJobs(
  companies: SmartRecruitersCompany[],
  keywords: string[],
  targetRoles: string[],
  searchLocation: string,
  prefersRemote: boolean,
  yearsOfExperience: number = 0,
): Promise<RawCommunityJob[]> {
  const results = await Promise.allSettled(
    companies.map(async (company): Promise<RawCommunityJob[]> => {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 8000);
      try {
        const searchUrl = globalState.templates.smartrecruitersPostings.replace(/{slug}/g, company.slug);
        const response = await fetch(searchUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
          signal: ctrl.signal,
        });
        clearTimeout(tid);
        if (!response.ok) {
          console.error(`[SmartRecruiters] Fetch failed for ${company.name}: HTTP ${response.status}`);
          return [];
        }

        const data = (await response.json()) as any;
        const postings = (data.content || []) as any[];
        const matchingPostings = postings.filter((p) => {
          const title = p.name || "";
          return matchesKeywords(title, keywords) && !isBlocklistedRole(title, targetRoles, yearsOfExperience);
        });

        const detailedJobs = await Promise.all(
          matchingPostings.map(async (p): Promise<RawCommunityJob | null> => {
            const detailUrl = globalState.templates.smartrecruitersDetails.replace(/{slug}/g, company.slug).replace(/{id}/g, p.id);
            const dCtrl = new AbortController();
            const dTid = setTimeout(() => dCtrl.abort(), 5000);
            try {
              const dRes = await fetch(detailUrl, {
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
                signal: dCtrl.signal,
              });
              clearTimeout(dTid);

              if (dRes.ok) {
                const dData = (await dRes.json()) as any;
                const jobDescHtml = [
                  dData.jobAd?.sections?.jobDescription?.text || "",
                  dData.jobAd?.sections?.qualifications?.text || "",
                  dData.jobAd?.sections?.additionalInformation?.text || "",
                ]
                  .filter(Boolean)
                  .join("\n\n");
                const desc = stripHtmlCommunity(jobDescHtml).slice(0, 15000);
                const loc = [dData.location?.city, dData.location?.region, dData.location?.country].filter(Boolean).join(", ") || "Remote";
                if (!matchesLocation(loc, searchLocation, prefersRemote)) return null;
                return {
                  title: p.name,
                  company: company.name,
                  location: loc,
                  description: desc,
                  url: `https://careers.smartrecruiters.com/${company.slug}/${p.id}`,
                  postedAt: p.releasedDate || new Date().toISOString(),
                  type: "Full-Time",
                  isRemote: loc.toLowerCase().includes("remote") || dData.location?.remote === true,
                  source: "smartrecruiters" as const,
                };
              }
            } catch (err: any) {
              clearTimeout(dTid);
              console.error(`[SmartRecruiters] Details failed for ${company.name} job ${p.id}:`, err?.message);
            }

            const loc = [p.location?.city, p.location?.region, p.location?.country].filter(Boolean).join(", ") || "Remote";
            if (!matchesLocation(loc, searchLocation, prefersRemote)) return null;
            return {
              title: p.name,
              company: company.name,
              location: loc,
              description: "Position details available on application site.",
              url: `https://careers.smartrecruiters.com/${company.slug}/${p.id}`,
              postedAt: p.releasedDate || new Date().toISOString(),
              type: "Full-Time",
              isRemote: loc.toLowerCase().includes("remote"),
              source: "smartrecruiters" as const,
            };
          }),
        );

        return detailedJobs.filter(Boolean) as RawCommunityJob[];
      } catch (err: any) {
        clearTimeout(tid);
        console.error(`[SmartRecruiters] Failed fetching ${company.name} jobs:`, err?.message);
        return [];
      }
    }),
  );

  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

export async function fetchRemoteOKJobs(
  keywords: string[],
  skills: string[],
  targetRoles: string[],
  searchLocation: string,
  prefersRemote: boolean,
  yearsOfExperience: number = 0,
): Promise<RawCommunityJob[]> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch("https://remoteok.com/api", {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; JobSearchAgent/1.0)" },
    });
    clearTimeout(tid);
    if (!res.ok) return [];
    const raw: any[] = (await res.json()) as any;
    const allKw = [...keywords, ...skills.map((s) => s.toLowerCase())];
    return raw
      .slice(1)
      .filter(Boolean)
      .filter((j) => {
        if (!j.position || !j.company) return false;
        const title = j.position;
        const tags = (j.tags || []).map((t: string) => t.toLowerCase());
        const loc = j.location || "Remote";
        const titleMatches = matchesKeywords(title, allKw) || tags.some((t: string) => allKw.some((kw) => t.includes(kw)));
        return titleMatches && !isBlocklistedRole(title, targetRoles, yearsOfExperience) && matchesLocation(loc, searchLocation, prefersRemote);
      })
      .map((j) => ({
        title: j.position,
        company: j.company,
        location: j.location || "Remote",
        description: j.description ? stripHtmlCommunity(j.description).slice(0, 15000) : "",
        url: j.apply_url || j.url || "",
        applyUrl: j.apply_url,
        postedAt: j.date || new Date().toISOString(),
        type: "Full-Time",
        salary: j.salary || (j.salaryMin ? `$${Math.round(j.salaryMin / 1000)}k–$${Math.round(j.salaryMax / 1000)}k` : undefined),
        isRemote: true,
        source: "remoteok" as const,
      }));
  } catch {
    clearTimeout(tid);
    console.error("[RemoteOK] Fetch failed");
    return [];
  }
}

export async function fetchRemotiveJobs(
  keywords: string[],
  skills: string[],
  targetRoles: string[],
  searchLocation: string,
  prefersRemote: boolean,
  yearsOfExperience: number = 0,
): Promise<RawCommunityJob[]> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 10000);
  try {
    const categories: string[] = [];
    const rolesLower = targetRoles.map((r) => r.toLowerCase());

    if (rolesLower.some((r) => r.includes("design") || r.includes("ui") || r.includes("ux") || r.includes("creative"))) categories.push("design");
    if (rolesLower.some((r) => r.includes("product") || r.includes("pm") || r.includes("program manager"))) categories.push("product");
    if (rolesLower.some((r) => r.includes("data") || r.includes("analyst") || r.includes("analytics") || r.includes("science"))) categories.push("data");
    if (rolesLower.some((r) => r.includes("devops") || r.includes("sre") || r.includes("reliability") || r.includes("infrastructure") || r.includes("sysadmin") || r.includes("platform"))) categories.push("devops");

    if (
      categories.length === 0 ||
      rolesLower.some(
        (r) =>
          r.includes("software") || r.includes("engineer") || r.includes("developer") || r.includes("frontend") || r.includes("backend") || r.includes("fullstack") || r.includes("web") || r.includes("tech"),
      )
    ) {
      categories.push("software-development");
    }

    const allJobs: RawCommunityJob[] = [];
    const allKw = [...keywords, ...skills.map((s) => s.toLowerCase())];

    await Promise.all(
      categories.map(async (category) => {
        try {
          const res = await fetch(`https://remotive.com/api/remote-jobs?category=${category}`, {
            signal: ctrl.signal,
            headers: { "User-Agent": "Mozilla/5.0 (compatible; JobSearchAgent/1.0)" },
          });
          if (!res.ok) return;
          const data = (await res.json()) as any;
          const raw = data.jobs || [];
          const mapped = raw
            .filter((j: any) => {
              if (!j.title || !j.company_name) return false;
              const title = j.title;
              const tags = (j.tags || []).map((t: string) => t.toLowerCase());
              const loc = j.candidate_required_location || "Remote";
              const titleMatches = matchesKeywords(title, allKw) || tags.some((t: string) => allKw.some((kw) => t.includes(kw)));
              return titleMatches && !isBlocklistedRole(title, targetRoles, yearsOfExperience) && matchesLocation(loc, searchLocation, prefersRemote);
            })
            .map((j: any) => ({
              title: j.title,
              company: j.company_name,
              location: j.candidate_required_location || "Remote",
              description: j.description ? stripHtmlCommunity(j.description).slice(0, 15000) : "",
              url: j.url || "",
              postedAt: j.publication_date || new Date().toISOString(),
              type: j.job_type === "contract" ? "Contract" : "Full-Time",
              salary: j.salary || undefined,
              isRemote: true,
              source: "remotive" as const,
            }));
          allJobs.push(...mapped);
        } catch (e: any) {
          console.error(`[Remotive] Category ${category} fetch failed:`, e?.message);
        }
      }),
    );

    clearTimeout(tid);

    const seen = new Set<string>();
    return allJobs.filter((job) => {
      const key = `${job.title.toLowerCase().trim()}|${job.company.toLowerCase().trim()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch (err: any) {
    clearTimeout(tid);
    console.error("[Remotive] Sourcing failed:", err?.message);
    return [];
  }
}

export async function fetchHackerNewsJobs(
  keywords: string[],
  skills: string[],
  _targetRoles: string[],
  _searchLocation: string,
  _prefersRemote: boolean,
  _yearsOfExperience: number = 0,
): Promise<RawCommunityJob[]> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 12000);
  try {
    const searchUrl = "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10";
    const searchRes = await fetch(searchUrl, { signal: ctrl.signal });
    if (!searchRes.ok) return [];
    const searchData = (await searchRes.json()) as any;
    const hits = searchData.hits || [];
    const story = hits.find((h: any) => h.title && h.title.includes("Who is hiring?"));
    if (!story) {
      console.error("[HackerNews] Latest hiring story not found in hits");
      return [];
    }

    const itemRes = await fetch(`https://hn.algolia.com/api/v1/items/${story.objectID}`, { signal: ctrl.signal });
    if (!itemRes.ok) return [];
    const itemData = (await itemRes.json()) as any;
    const comments = itemData.children || [];

    const allKw = [...keywords, ...skills.map((s) => s.toLowerCase())];
    const results: RawCommunityJob[] = [];

    for (const comment of comments) {
      if (!comment.text) continue;
      const strippedText = stripHtmlCommunity(comment.text);
      const textLower = strippedText.toLowerCase();
      if (!allKw.some((kw) => textLower.includes(kw))) continue;

      const lines = strippedText.split("\n").map((l) => l.trim()).filter(Boolean);
      const firstLine = lines[0] ? lines[0].substring(0, 80) : "Hacker News Post";

      results.push({
        title: firstLine,
        company: "Hacker News Community",
        location: "Remote / On-site",
        description: strippedText.slice(0, 15000),
        url: `https://news.ycombinator.com/item?id=${comment.id}`,
        postedAt: comment.created_at || new Date().toISOString(),
        type: "Full-Time",
        isRemote: true,
        source: "hackernews" as const,
      });
    }

    clearTimeout(tid);
    return results;
  } catch (err: any) {
    clearTimeout(tid);
    console.error("[HackerNews] Sourcing failed:", err?.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// LinkedIn (public guest endpoints; optional authenticated Voyager mode).
// Search returns listing metadata only; descriptions are fetched per-job from
// the jobPosting detail endpoint (enrichment happens in pipeline for kept jobs).
// ---------------------------------------------------------------------------

export interface LinkedInQuery {
  keyword: string;
  location: string;
  targetRoles: string[];
  yearsOfExperience: number;
  prefersRemote: boolean;
  datePosted?: string; // "24hr" | "past week" | "past month"
  remote?: string; // "on site" | "remote" | "hybrid"
  jobType?: string; // "full time" | "part time" | "contract" | ...
  experienceLevel?: string; // "entry level" | "associate" | "senior" | ...
  salaryMin?: number;
  sortBy?: string; // "recent" | "relevant"
  maxApplicants?: number; // when set, triggers LinkedIn's early-applicant filter (f_EA)
  limit: number;
}

// Guest search filter-code mappings (LinkedIn's f_* params).
const LI_DATE: Record<string, string> = { "24hr": "r86400", "past week": "r604800", "past month": "r2592000" };
const LI_REMOTE: Record<string, string> = { "on site": "1", remote: "2", hybrid: "3" };
const LI_JOBTYPE: Record<string, string> = { "full time": "F", "part time": "P", contract: "C", temporary: "T", internship: "I", volunteer: "V" };
const LI_EXP: Record<string, string> = { internship: "1", "entry level": "2", entry: "2", associate: "3", senior: "4", mid: "4", director: "5", executive: "6" };

function liSalaryBucket(min?: number): string | undefined {
  if (!min) return undefined;
  if (min >= 120000) return "5";
  if (min >= 100000) return "4";
  if (min >= 80000) return "3";
  if (min >= 60000) return "2";
  if (min >= 40000) return "1";
  return undefined;
}

/** Extract the numeric job id from a LinkedIn job URL or urn. */
export function linkedInJobIdFromUrl(url: string): string | null {
  const m = url.match(/(\d{6,})/);
  return m ? m[1] : null;
}

/** Regex-parse the guest search HTML into listing rows (no cheerio). */
function parseLinkedInCards(html: string) {
  const out: { jobId: string; jobUrl: string; title: string; company: string; location: string; postedAt: string }[] = [];
  const re = /data-entity-urn="urn:li:jobPosting:(\d+)"/g;
  const marks: { id: string; pos: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) marks.push({ id: m[1], pos: m.index });

  for (let i = 0; i < marks.length; i++) {
    const chunk = html.slice(marks[i].pos, i + 1 < marks.length ? marks[i + 1].pos : undefined);
    const id = marks[i].id;
    const hrefM = chunk.match(/base-card__full-link[^>]*href="([^"]+)"/);
    const jobUrl = (hrefM ? hrefM[1].replace(/&amp;/g, "&") : `https://www.linkedin.com/jobs/view/${id}`).split("?")[0];
    const title = stripHtmlCommunity((chunk.match(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/) || [])[1] || "");
    const company =
      stripHtmlCommunity((chunk.match(/base-search-card__subtitle[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || "") ||
      stripHtmlCommunity((chunk.match(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/) || [])[1] || "");
    const location = stripHtmlCommunity((chunk.match(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/) || [])[1] || "");
    const postedAt = (chunk.match(/datetime="([^"]+)"/) || [])[1] || new Date().toISOString();
    if (id && title && company) out.push({ jobId: id, jobUrl, title, company, location, postedAt });
  }
  return out;
}

export async function fetchLinkedInJobs(q: LinkedInQuery): Promise<RawCommunityJob[]> {
  const buildParams = (start: number): string => {
    const p = new URLSearchParams();
    p.set("keywords", q.keyword);
    if (q.location) p.set("location", q.location);
    const tpr = q.datePosted ? LI_DATE[q.datePosted.toLowerCase()] : undefined;
    if (tpr) p.set("f_TPR", tpr);
    const wt = q.remote ? LI_REMOTE[q.remote.toLowerCase()] : undefined;
    if (wt) p.set("f_WT", wt);
    const jt = q.jobType ? LI_JOBTYPE[q.jobType.toLowerCase()] : undefined;
    if (jt) p.set("f_JT", jt);
    const e = q.experienceLevel ? LI_EXP[q.experienceLevel.toLowerCase()] : undefined;
    if (e) p.set("f_E", e);
    const sb = liSalaryBucket(q.salaryMin);
    if (sb) p.set("f_SB2", sb);
    // f_EA = LinkedIn's "early applicant" filter (verified live): the search returns
    // only low-applicant jobs ("be among the first ~25 applicants") instead of the
    // default 200+ ones. It's the ONLY guest-side applicant filter, so use it whenever a
    // cap is requested. Exact <=N filtering needs the cookie (Voyager exact counts).
    if (q.maxApplicants !== undefined) p.set("f_EA", "true");
    p.set("start", String(start));
    if (q.sortBy === "recent") p.set("sortBy", "DD");
    else if (q.sortBy === "relevant") p.set("sortBy", "R");
    return p.toString();
  };

  const collected: RawCommunityJob[] = [];
  const seen = new Set<string>();
  const maxPages = Math.min(3, Math.ceil(q.limit / 25) + 1);

  for (let page = 0; page < maxPages && collected.length < q.limit * 2; page++) {
    const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${buildParams(page * 25)}`;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(url, { headers: { "User-Agent": LINKEDIN_UA, "Accept-Language": "en-US,en;q=0.9" }, signal: ctrl.signal });
      clearTimeout(tid);
      if (!res.ok) {
        console.error(`[LinkedIn] search HTTP ${res.status}`);
        break;
      }
      const html = await res.text();
      const cards = parseLinkedInCards(html);
      if (cards.length === 0) {
        // Distinguish "no matches" from a likely markup change (HTTP 200 + real HTML, 0 parsed).
        if (html.length > 2000) console.error("[LinkedIn] HTTP 200 but parsed 0 job cards — card markup may have changed.");
        break;
      }
      for (const c of cards) {
        if (seen.has(c.jobId)) continue;
        seen.add(c.jobId);
        // LinkedIn already searched by keyword+location; only drop blocklisted/over-level titles.
        if (isBlocklistedRole(c.title, q.targetRoles, q.yearsOfExperience)) continue;
        collected.push({
          title: c.title,
          company: c.company,
          location: c.location || "Not specified",
          description: "", // enriched per-job later
          url: c.jobUrl,
          postedAt: c.postedAt,
          type: "Full-Time",
          isRemote: q.remote === "remote" || c.location.toLowerCase().includes("remote"),
          source: "linkedin" as const,
        });
      }
      await new Promise((r) => setTimeout(r, 300));
    } catch (err: any) {
      clearTimeout(tid);
      console.error("[LinkedIn] search failed:", err?.message);
      break;
    }
  }
  return collected;
}

/** Authenticated Voyager headers, or null when no cookie is configured. */
function linkedInAuthHeaders(): Record<string, string> | null {
  const li_at = process.env.LINKEDIN_LI_AT;
  const js = process.env.LINKEDIN_JSESSIONID;
  if (!li_at || !js) return null;
  const csrf = js.replace(/"/g, "");
  return {
    "User-Agent": LINKEDIN_UA,
    Cookie: `li_at=${li_at}; JSESSIONID="${csrf}"`,
    "csrf-token": csrf,
    "x-restli-protocol-version": "2.0.0",
    "x-li-lang": "en_US",
    Accept: "application/json",
  };
}

export interface LinkedInDetail {
  description: string;
  applicants: number | null;
  // "Be among the first N applicants" — a LOW-competition job. The parsed number is
  // an UPPER bound, so the applicant cap must never drop these.
  early: boolean;
}

/** Authenticated detail via Voyager JSON (richer, when a cookie is set). */
async function fetchVoyagerDetail(jobId: string, headers: Record<string, string>): Promise<LinkedInDetail | null> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`https://www.linkedin.com/voyager/api/jobs/jobPostings/${jobId}`, { headers, signal: ctrl.signal });
    clearTimeout(tid);
    if (!res.ok) return null;
    const data: any = await res.json();
    const node = data?.data ?? data;
    const text = node?.description?.text || data?.description?.text || "";
    if (!text) return null;
    const applies = node?.applies ?? data?.applies;
    // Voyager returns an EXACT applicant count, so early=false is intentional: the cap can
    // filter precisely here (unlike the guest detail page's "be among the first N" upper bound).
    return { description: stripHtmlCommunity(text).slice(0, 15000), applicants: typeof applies === "number" ? applies : null, early: false };
  } catch {
    clearTimeout(tid);
    return null;
  }
}

/** Full JD + applicant count for one job: Voyager when authenticated, else the guest detail page. */
export async function fetchLinkedInJobDetail(jobId: string): Promise<LinkedInDetail> {
  const auth = linkedInAuthHeaders();
  if (auth) {
    const v = await fetchVoyagerDetail(jobId, auth);
    if (v) return v;
  }
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`, {
      headers: { "User-Agent": LINKEDIN_UA, "Accept-Language": "en-US,en;q=0.9" },
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    if (!res.ok) return { description: "", applicants: null, early: false };
    const html = await res.text();
    const dm = html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/);
    const description = dm ? stripHtmlCommunity(dm[1]).slice(0, 15000) : "";
    // Caption is a <span> ("115 applicants") for popular roles or a <figcaption>
    // ("Be among the first 25 applicants") for new/under-10 ones — match either by
    // capturing the text up to the next tag.
    const cap = (html.match(/num-applicants__caption[^>]*>([^<]*)/) || [])[1] || "";
    const nm = cap.match(/([\d,]+)/);
    const applicants = nm ? parseInt(nm[1].replace(/,/g, ""), 10) : null;
    return { description, applicants, early: /\bfirst\b/i.test(cap) };
  } catch {
    clearTimeout(tid);
    return { description: "", applicants: null, early: false };
  }
}
