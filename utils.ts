/**
 * Sourcing helpers, ported from the original job-search-agent (server/utils.ts).
 * Trimmed to what deterministic sourcing + the find_jobs pipeline use: keyword/
 * location/role matching, HTML stripping, URL structural checks + verification,
 * URL normalization, and a concurrency limiter. console.* routed to stderr.
 */
import { ROLE_TITLE_BLOCKLIST, ROLE_KEYWORD_EXCLUSIONS, SLUG_DISPLAY_NAMES } from "./config.js";

/** Async map with a concurrency limit (avoids socket exhaustion / rate-limit bursts). */
export async function asyncMapConcurrent<T, U>(
  array: T[],
  limit: number,
  mapper: (item: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(array.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < array.length) {
      const index = currentIndex++;
      results[index] = await mapper(array[index]);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(limit, array.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/** True if the URL looks like a specific job posting rather than a generic careers/root page. */
export function isSpecificJobPost(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    const isATS =
      hostname.includes("lever.co") ||
      hostname.includes("greenhouse.io") ||
      hostname.includes("myworkdayjobs.com") ||
      hostname.includes("ashbyhq.com") ||
      hostname.includes("smartrecruiters.com") ||
      hostname.includes("bamboohr.com") ||
      hostname.includes("recruitee.com") ||
      hostname.includes("workable.com") ||
      hostname.includes("jobvite.com");

    const pathSegments = pathname.split("/").filter(Boolean);

    if (isATS) {
      if (pathSegments.length <= 1) return false;
      if (hostname.includes("greenhouse.io") && !pathname.includes("/jobs/")) return false;
      if (hostname.includes("myworkdayjobs.com") && !pathname.includes("/job/")) return false;
      return true;
    }

    if (hostname.includes("linkedin.com") && pathname.includes("/jobs/view/")) return true;
    if (hostname.includes("indeed.com") && (pathname.includes("/rc/clk") || pathname.includes("/viewjob"))) return true;

    const genericTerms = [
      "/careers", "/careers/", "/career", "/career/",
      "/jobs", "/jobs/", "/job", "/job/",
      "/join", "/join/", "/join-us", "/join-us/",
      "/work-at", "/work-at/", "/work-with-us", "/work-with-us/",
      "/about/careers", "/about/jobs", "/hiring", "/hiring/",
      "/about", "/about/", "/our-story", "/our-story/",
    ];
    if (genericTerms.some((term) => pathname === term)) return false;

    if (pathSegments.length === 0) return false;
    if (pathSegments.length === 1) {
      const singleSeg = pathSegments[0];
      const isLikelyGeneric = ["careers", "jobs", "career", "job", "hiring", "about", "join", "portal", "search"].includes(singleSeg);
      if (isLikelyGeneric) return false;
    }

    const hasJobIndicators =
      /\d+/.test(pathname) ||
      pathname.includes("/job/") ||
      pathname.includes("/jobs/") ||
      pathname.includes("/careers/") ||
      pathname.includes("/vacancy/") ||
      pathname.includes("/apply/") ||
      pathname.includes("/details/") ||
      pathname.includes("-eng-") ||
      pathname.includes("-engineer-") ||
      pathname.includes("-manager-") ||
      pathSegments.some((seg) => seg.length > 12);

    return hasJobIndicators;
  } catch {
    return false;
  }
}

/** Network-verify a job URL: structural pre-filter, then a GET (follows redirects). Non-fatal on block. */
export async function verifyJobUrl(url: string): Promise<{ isValid: boolean; resolvedUrl: string }> {
  if (!url || typeof url !== "string" || !url.startsWith("http")) {
    return { isValid: false, resolvedUrl: url };
  }
  if (!isSpecificJobPost(url)) return { isValid: false, resolvedUrl: url };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const status = response.status;
    const finalUrl = response.url || url;
    if (!isSpecificJobPost(finalUrl)) return { isValid: false, resolvedUrl: finalUrl };

    const isPageReachable = response.ok || status === 301 || status === 302;
    const isServerBlocking = status === 403 || status === 429 || status === 401;
    return { isValid: isPageReachable || isServerBlocking, resolvedUrl: finalUrl };
  } catch (err: any) {
    clearTimeout(timeoutId);
    console.error(`URL validation failed for ${url}:`, err?.message || err);
    // Bot-protection blocks can fail the fetch even though the URL is clearly a real job post.
    const isHighlyLikelyJob =
      url.includes("lever.co") ||
      url.includes("greenhouse.io") ||
      url.includes("myworkdayjobs.com") ||
      url.includes("ashbyhq.com");
    return { isValid: isHighlyLikelyJob, resolvedUrl: url };
  }
}

export function detectUSState(locStr: string): string | null {
  const stateNames: { [key: string]: string } = {
    alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
    colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
    hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
    kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
    massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
    missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH",
    "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC",
    "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
    "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN",
    texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
    "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  };

  const lowerStr = locStr.toLowerCase();
  for (const [name, abbrev] of Object.entries(stateNames)) {
    if (new RegExp(`\\b${name}\\b`, "i").test(lowerStr)) return abbrev;
  }
  for (const abbrev of Object.values(stateNames)) {
    if (new RegExp(`\\b${abbrev}\\b`).test(locStr)) return abbrev;
  }
  for (const abbrev of Object.values(stateNames)) {
    if (new RegExp(`,\\s*${abbrev.toLowerCase()}\\b`).test(lowerStr)) return abbrev;
  }
  return null;
}

export function normalizeLocation(locStr: string): string {
  if (!locStr) return "";
  let normalized = locStr.toLowerCase().trim();
  normalized = normalized.replace(/\b(us|usa)\b/g, "united states");
  normalized = normalized.replace(/\buk\b/g, "united kingdom");

  const stateAbbrevToName: { [key: string]: string } = {
    al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california",
    co: "colorado", ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia",
    hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa",
    ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland",
    ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi",
    mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire",
    nj: "new jersey", nm: "new mexico", ny: "new york", nc: "north carolina",
    nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania",
    ri: "rhode island", sc: "south carolina", sd: "south dakota", tn: "tennessee",
    tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington",
    wv: "west virginia", wi: "wisconsin", wy: "wyoming",
  };

  for (const [abbrev, name] of Object.entries(stateAbbrevToName)) {
    normalized = normalized.replace(new RegExp(`,\\s*\\b${abbrev}\\b`, "g"), `, ${name}`);
    normalized = normalized.replace(new RegExp(`\\b${abbrev}\\b$`, "g"), name);
  }
  return normalized;
}

export function matchesLocation(jobLocation: string, searchLocation: string, prefersRemote: boolean): boolean {
  const normJob = normalizeLocation(jobLocation);
  if (!searchLocation) return true;
  const normSearch = normalizeLocation(searchLocation);

  const isUS = (s: string) => /\b(united states|america)\b/i.test(s);
  const isSearchUS = isUS(normSearch) || !!detectUSState(normSearch);
  const isGenericUSSearch = ["united states", "us", "usa", "america"].includes(normSearch.trim());

  if (isSearchUS) {
    const nonUSCountries = [
      "india", "germany", "london", "uk", "united kingdom", "canada", "brazil",
      "poland", "romania", "france", "spain", "australia", "singapore", "japan",
      "netherlands", "sweden", "switzerland", "ireland", "china", "berlin", "munich",
      "bangalore", "pune", "delhi", "mumbai", "hyderabad", "toronto", "vancouver", "madrid", "barcelona",
    ];
    const mentionsNonUS = nonUSCountries.some((country) => new RegExp(`\\b${country}\\b`, "i").test(normJob));
    if (mentionsNonUS) {
      const mentionsUS = isUS(normJob) || !!detectUSState(normJob);
      if (!mentionsUS) return false;
    }
  }

  const searchState = detectUSState(normSearch);
  if (searchState) {
    const jobState = detectUSState(normJob);
    if (jobState && jobState !== searchState) return false;
  }

  if (prefersRemote && normJob.includes("remote")) return true;
  if (isGenericUSSearch && isUS(normJob)) return true;
  if (!normJob.includes(normSearch) && !normJob.includes("remote")) return false;
  return true;
}

/** Derive lowercase keyword tokens (length >= 4) from target-role phrases, minus stop-words. */
export function extractRoleKeywords(targetRoles: string[]): string[] {
  const stop = new Set(ROLE_KEYWORD_EXCLUSIONS);
  return [
    ...new Set(
      targetRoles.flatMap((r) =>
        r.toLowerCase().split(/[\s,\/\-\(\)]+/).filter((w) => w.length >= 4 && !stop.has(w)),
      ),
    ),
  ];
}

export function matchesKeywords(title: string, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const text = title.toLowerCase();
  return keywords.some((kw) => text.includes(kw));
}

export function communitySlugToName(slug: string): string {
  return SLUG_DISPLAY_NAMES[slug] ?? slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export function stripHtmlCommunity(html: string): string {
  if (!html) return "";
  let decoded = html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  decoded = decoded
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ");
  return decoded.replace(/\s+/g, " ").trim();
}

export function isBlocklistedRole(title: string, targetRoles: string[], yearsOfExperience: number = 0): boolean {
  const lowerTitle = title.toLowerCase();
  const lowerTargets = targetRoles.map((r) => r.toLowerCase());

  if (yearsOfExperience > 0) {
    if (yearsOfExperience < 5) {
      const seniorBlocked = ["staff", "principal", "director", "vp", "vice president", "manager", "architect"];
      if (seniorBlocked.some((term) => new RegExp(`\\b${term}\\b`, "i").test(lowerTitle))) return true;
    }
    if (yearsOfExperience < 4 && /\blead\b/i.test(lowerTitle)) return true;
    if (yearsOfExperience < 3 && (/\bsenior\b|\bsr\b/i).test(lowerTitle)) return true;
  }

  return ROLE_TITLE_BLOCKLIST.some((blocked) => {
    if (lowerTitle.includes(blocked)) {
      const userWantsIt = lowerTargets.some((target) => target.includes(blocked));
      if (!userWantsIt) return true;
    }
    return false;
  });
}

export function normalizeJobUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    url.search = "";
    url.hash = "";
    let href = url.href.toLowerCase();
    if (href.endsWith("/")) href = href.slice(0, -1);
    return href;
  } catch {
    return urlStr.toLowerCase();
  }
}
