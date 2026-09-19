/**
 * The backend is a Worker project and deliberately carries no Node type package, so `tsc` knows
 * nothing about `node:fs`. One test reads `apps/src/renderer.js` to hold its `ROSTER_CUTOFF_MS` and
 * the backend mirror that derives `LAST_SEEN_STALENESS_BOUND_MS` from it together, and that read
 * happens in Vitest on Node, never in the Worker. Declare only the single function it uses, so an
 * import of anything else from `node:fs` still fails to compile.
 */
declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: "utf8"): string;
}
