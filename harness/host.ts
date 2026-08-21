/**
 * Local host harness for the job-search MCP App UI.
 *
 * Stands in for Claude Desktop: it loads the built single-file widget into a sandboxed
 * iframe and speaks the ui/* protocol to it over ext-apps' AppBridge, backed by a
 * synthetic job store. It exists because the widget's real failure modes only appear
 * when a host is on the other end of the bridge: link opening, theming and the
 * post-mount refresh are all host-mediated and all look fine in a plain browser tab.
 *
 * It is a host, not a server. Tool calls are answered from the in-memory fixture, so
 * nothing here touches the real job store on disk.
 */
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { PostMessageTransport, type McpUiStyles } from "@modelcontextprotocol/ext-apps";
import { HarnessStore } from "./fixture";
import widgetHtml from "../dist/mcp-app.html?raw";

/**
 * Stand-ins for the CSS variables Claude passes down. A real host sends the full set of
 * ~70; the widget only reads a handful, so these are cast to the full type rather than
 * padded out with dozens of placeholder values that would obscure the ones that matter.
 */
const LIGHT = {
  "--color-background-primary": "#ffffff",
  "--color-text-primary": "#141413",
  "--color-text-secondary": "#6b6b68",
} as Partial<McpUiStyles> as McpUiStyles;
const DARK = {
  "--color-background-primary": "#1f1f1f",
  "--color-text-primary": "#f5f5f4",
  "--color-text-secondary": "#a3a3a0",
} as Partial<McpUiStyles> as McpUiStyles;

const store = new HarnessStore();
const params = new URLSearchParams(location.search);
const view = params.get("view") === "saved" ? "saved" : "board";
let theme: "light" | "dark" = params.get("theme") === "dark" ? "dark" : "light";

const logEl = document.getElementById("log")!;
const log = (m: string) => {
  logEl.textContent += m + "\n";
  console.log("[harness]", m);
};

const iframe = document.getElementById("frame") as HTMLIFrameElement;
// Real hosts sandbox the widget with allow-scripts only, so that is the default and the
// faithful case. ?sameorigin=1 additionally grants allow-same-origin, which lets the parent
// (or a test driver) reach into the widget's DOM to assert on what actually rendered.
iframe.setAttribute("sandbox", params.get("sameorigin") === "1" ? "allow-scripts allow-same-origin" : "allow-scripts");
iframe.srcdoc = widgetHtml;
await new Promise<void>((r) => iframe.addEventListener("load", () => r(), { once: true }));

const bridge = new AppBridge(
  null, // no MCP client: tool calls are served from the fixture below
  { name: "Harness Host", version: "1.0.0" },
  // serverTools is what lets the widget call back through the host (app.callServerTool);
  // openLinks is what makes it prefer ui/open-link over a doomed sandboxed anchor.
  { openLinks: {}, serverTools: {} },
  {
    hostContext: {
      theme,
      styles: { variables: theme === "dark" ? DARK : LIGHT },
      displayMode: "inline",
      safeAreaInsets: { top: 16, right: 16, bottom: 16, left: 16 },
    },
  },
);

bridge.oncalltool = async (p) => {
  log(`-> tools/call ${p.name} ${JSON.stringify(p.arguments ?? {})}`);
  const args = (p.arguments ?? {}) as Record<string, unknown>;
  if (p.name === "set_status") {
    const ok = store.setStatus(String(args.job_id), String(args.status));
    if (!ok) return { isError: true, content: [{ type: "text" as const, text: `Job ${args.job_id} not found.` }] };
  }
  // Both tools return the current board, matching the server's FIND_JOBS_OUTPUT contract.
  const next = args.view === "saved" ? "saved" : view;
  return store.result(next as "board" | "saved");
};

bridge.onopenlink = async ({ url }) => {
  // Log rather than navigate: seeing this line is the proof the widget used ui/open-link
  // instead of an anchor that would have died inside the sandbox.
  log(`-> ui/open-link ${url}`);
  return {};
};

bridge.onsizechange = ({ height }) => {
  if (height) iframe.style.height = `${height}px`;
};

bridge.oninitialized = () => {
  document.getElementById("status")!.textContent = "connected";
  log(`app: ${JSON.stringify(bridge.getAppVersion())}`);
  bridge.sendToolResult(store.result(view));
};

await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));

document.getElementById("toggle")!.addEventListener("click", () => {
  theme = theme === "light" ? "dark" : "light";
  document.body.dataset.host = theme;
  bridge.sendHostContextChange({ theme, styles: { variables: theme === "dark" ? DARK : LIGHT } });
  log(`<- host-context-changed theme=${theme}`);
});
