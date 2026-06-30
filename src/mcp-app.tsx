/**
 * @file Job-search MCP App UI: renders the jobs find_jobs/evaluate_jobs return and
 * lets you triage them inline.
 *
 * Data arrives via the host bridge (useApp -> ontoolresult): we read
 * structuredContent.{jobs,profile} and render ranked cards (by match score once
 * evaluated). Triage buttons call set_status through the bridge and optimistically
 * drop the card. Scoring itself is done by Claude (evaluate_jobs) + the server, not
 * here.
 */
import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StrictMode, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";

interface UiJob {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  postedAt: string;
  status: string;
  sourceTag?: string;
  salary?: string;
  isRemote?: boolean;
  matchScore: number; // -1 = unscored
  matchReason?: string;
  experienceLevel?: string;
  skillsRequired?: string[];
  applicants?: number;
}

interface UiProfile {
  parsedName?: string;
  parsedSkills?: string[];
  targetRoles?: string[];
  searchLocation?: string;
  prefersRemote?: boolean;
  yearsOfExperience?: number;
}

interface BoardData {
  jobs: UiJob[];
  count: number;
  scored: boolean;
  profile: UiProfile | null;
}

const EMPTY: BoardData = { jobs: [], count: 0, scored: false, profile: null };

type TriageStatus = "saved" | "applied" | "dismissed";

/** Pull the structured payload out of a tool result (with a defensive fallback). */
function extractData(result: CallToolResult | null): BoardData {
  if (!result) return EMPTY;
  const sc = (result as { structuredContent?: Partial<BoardData> }).structuredContent;
  if (sc && Array.isArray(sc.jobs)) {
    return {
      jobs: sc.jobs as UiJob[],
      count: sc.count ?? sc.jobs.length,
      scored: sc.scored ?? false,
      profile: (sc.profile as UiProfile | null) ?? null,
    };
  }
  return EMPTY;
}

function JobSearchApp() {
  const [result, setResult] = useState<CallToolResult | null>(null);
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();
  const refreshedRef = useRef(false);

  const { app, error } = useApp({
    appInfo: { name: "Job Search Review", version: "0.1.0" },
    capabilities: {},
    onAppCreated: (app) => {
      app.ontoolresult = async (r) => setResult(r);
      app.onhostcontextchanged = (params) => setHostContext((prev) => ({ ...prev, ...params }));
      app.onerror = console.error;
      app.onteardown = async () => ({});
    },
  });

  useEffect(() => {
    if (app) setHostContext(app.getHostContext());
  }, [app]);

  // After (re)mount, re-fetch the live board/tracker from the server once the first result
  // arrives. On a tab-switch remount the host replays a STALE snapshot — jobs triaged via the
  // buttons moved server-side but aren't reflected — so refresh to server truth (once).
  useEffect(() => {
    if (!app || !result || refreshedRef.current) return;
    refreshedRef.current = true;
    const view = (result as { structuredContent?: { view?: string } }).structuredContent?.view === "saved" ? "saved" : "board";
    app
      .callServerTool({ name: "show_board", arguments: { view } })
      .then((r) => setResult(r as CallToolResult))
      .catch(() => {});
  }, [app, result]);

  if (error) {
    return (
      <div style={{ padding: 16 }}>
        <strong>Error:</strong> {error.message}
      </div>
    );
  }
  if (!app) return <div style={{ padding: 16 }}>Connecting…</div>;

  return <Review app={app} result={result} hostContext={hostContext} />;
}

function Review({
  app,
  result,
  hostContext,
}: {
  app: App;
  result: CallToolResult | null;
  hostContext?: McpUiHostContext;
}) {
  const data = useMemo(() => extractData(result), [result]);
  const { profile } = data;

  // Locally hidden ids (optimistic triage) + per-card busy state. Reset on a new result.
  const [triaged, setTriaged] = useState<Record<string, TriageStatus>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  useEffect(() => {
    setTriaged({});
    setBusyId(null);
  }, [result]);

  const jobs = useMemo(() => {
    const visible = data.jobs.filter((j) => !triaged[j.id]);
    return [...visible].sort((a, b) => b.matchScore - a.matchScore); // scored first; unscored (-1) last
  }, [data.jobs, triaged]);

  const pad: CSSProperties = {
    paddingTop: hostContext?.safeAreaInsets?.top ?? 16,
    paddingRight: hostContext?.safeAreaInsets?.right ?? 16,
    paddingBottom: hostContext?.safeAreaInsets?.bottom ?? 16,
    paddingLeft: hostContext?.safeAreaInsets?.left ?? 16,
  };

  const onStatus = (job: UiJob, status: TriageStatus) => {
    setBusyId(job.id);
    setTriaged((prev) => ({ ...prev, [job.id]: status })); // optimistic
    app
      .callServerTool({ name: "set_status", arguments: { job_id: job.id, status } })
      .catch((e) => console.error(e))
      .finally(() => setBusyId((id) => (id === job.id ? null : id)));
  };

  const triagedCount = Object.keys(triaged).length;

  if (data.jobs.length === 0) {
    return (
      <main style={{ ...pad, maxWidth: 760, margin: "0 auto" }}>
        <p style={{ color: "var(--muted)" }}>
          No jobs yet. Ask Claude to run <code>find_jobs</code>.
        </p>
      </main>
    );
  }

  return (
    <main style={{ ...pad, maxWidth: 760, margin: "0 auto" }}>
      <Header profile={profile} count={jobs.length} scored={data.scored} triaged={triagedCount} />
      {jobs.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>All caught up — every job triaged.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} busy={busyId === job.id} onStatus={onStatus} />
          ))}
        </div>
      )}
    </main>
  );
}

function Header({
  profile,
  count,
  scored,
  triaged,
}: {
  profile: UiProfile | null;
  count: number;
  scored: boolean;
  triaged: number;
}) {
  return (
    <header style={{ marginBottom: 16 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>
        {count} job{count === 1 ? "" : "s"} {scored ? "ranked" : "to review"}
        {triaged > 0 ? <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 13 }}> · {triaged} triaged</span> : null}
      </h2>
      {profile && (
        <p style={{ margin: 0, color: "var(--muted)", fontSize: 13 }}>
          {profile.parsedName ? `${profile.parsedName} · ` : ""}
          {profile.targetRoles?.length ? `${profile.targetRoles.slice(0, 3).join(", ")} · ` : ""}
          {profile.searchLocation ?? ""}
          {typeof profile.yearsOfExperience === "number" ? ` · ${profile.yearsOfExperience}y exp` : ""}
        </p>
      )}
      {!scored && (
        <p style={{ margin: "6px 0 0", color: "var(--muted)", fontSize: 12 }}>
          Unscored. Ask Claude to “evaluate these jobs” to rank them.
        </p>
      )}
    </header>
  );
}

function scoreColor(score: number): string {
  if (score < 0) return "var(--muted)";
  if (score >= 75) return "var(--good)";
  if (score >= 50) return "var(--warn)";
  return "var(--bad)";
}

function ScoreBadge({ score }: { score: number }) {
  const scored = score >= 0;
  return (
    <span
      style={{
        flexShrink: 0,
        fontSize: scored ? 15 : 12,
        fontWeight: 700,
        minWidth: 34,
        textAlign: "center",
        padding: "2px 8px",
        borderRadius: 999,
        border: `1px solid ${scoreColor(score)}`,
        color: scoreColor(score),
        whiteSpace: "nowrap",
      }}
      title={scored ? "Match score (0-100)" : "Not yet evaluated"}
    >
      {scored ? score : "—"}
    </span>
  );
}

function TriageButton({
  label,
  color,
  onClick,
  disabled,
}: {
  label: string;
  color: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1,
        padding: "6px 8px",
        fontSize: 13,
        fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
        color,
        background: "transparent",
        border: `1px solid var(--border)`,
        borderRadius: 8,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

function JobCard({ job, busy, onStatus }: { job: UiJob; busy: boolean; onStatus: (job: UiJob, s: TriageStatus) => void }) {
  return (
    <article
      style={{
        border: "1px solid var(--border)",
        background: "var(--card-bg)",
        borderRadius: 10,
        padding: 12,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{job.title}</div>
          <div style={{ color: "var(--muted)", fontSize: 13 }}>
            {job.company} · {job.location}
            {job.salary ? ` · ${job.salary}` : ""}
            {job.experienceLevel ? ` · ${job.experienceLevel}` : ""}
            {typeof job.applicants === "number" ? ` · ${job.applicants} applicant${job.applicants === 1 ? "" : "s"}` : ""}
          </div>
        </div>
        <ScoreBadge score={job.matchScore} />
      </div>

      {job.matchReason ? (
        <p style={{ margin: "8px 0 4px", fontSize: 12.5, color: "var(--muted)" }}>{job.matchReason}</p>
      ) : (
        <p style={{ margin: "8px 0 4px", fontSize: 13 }}>{job.description.slice(0, 200)}…</p>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <a href={job.url} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>
          View posting ↗
        </a>
        {job.sourceTag && (
          <span style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>{job.sourceTag}</span>
        )}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <TriageButton label="Applied" color="var(--good)" disabled={busy} onClick={() => onStatus(job, "applied")} />
        <TriageButton label="Skip" color="var(--muted)" disabled={busy} onClick={() => onStatus(job, "dismissed")} />
      </div>
    </article>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <JobSearchApp />
  </StrictMode>,
);
