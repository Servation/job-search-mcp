import { defineConfig } from "vite";

// Serves the harness page itself. The widget under test is NOT built here: the harness
// imports the already-bundled dist/mcp-app.html as a raw string, exactly as the server
// serves it, so what you see is the same single file the host would render.
// Run `npm run build:ui` first (or `npm run harness`, which does it for you).
export default defineConfig({
  root: "harness",
  server: { port: 5199, open: false },
});
