/**
 * Client-bundle secret scan (security pass).
 *
 *   pnpm build && pnpm test:bundle-secrets        # after a real production build
 *
 * WHAT THIS PROVES: that nothing a BROWSER can fetch from this deployment
 * carries the service credential, the name of a server-only variable, the
 * upstream endpoint, or anything credential-shaped. It scans:
 *
 *   - `.next/static`: every client chunk and asset the HTML links
 *   - prerendered documents under `.next/server/app` (html, rsc, json)
 *   - `public`: copied-through public assets
 *
 * and it checks each of them for
 *
 *   1. the CONFIGURED SECRET VALUES, when the environment (or the gitignored
 *      `.env.local`) holds one — the real thing, not a pattern that looks like it;
 *   2. the names of server-only variables (a name in the client bundle is how a
 *      credential ends up inlined by a later edit);
 *   3. the upstream endpoint hosts (a browser that knows the endpoint is one
 *      refactor away from talking to it);
 *   4. credential SHAPES (`sk-…`, `vck_…`, `Bearer …`) for a secret this
 *      repository does not know the value of.
 *
 * WHAT IT NEVER PRINTS: any secret material — not a value, not a prefix, not a
 * length. Findings name the FILE and the PATTERN only.
 *
 * THE GATE IS EARNED, NOT ASSUMED: a missing build output is a FAILURE (not a
 * skip), the scan must cover a floor of files and bytes to count as a scan, and
 * the matcher self-tests against decoys plus a control run over the SERVER
 * chunks — where the variable names are expected to exist — so "nothing
 * flagged" cannot be the result of a scanner that matches nothing at all.
 *
 * Exit code 0 only when every check passes and the summary line is printed.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const CLIENT_DIRS = [".next/static"];
const PUBLIC_DOCS = [".next/server/app"];
const PUBLIC_ASSETS = ["public"];
/** The server chunks are the CONTROL, never a failure: names belong here. */
const CONTROL_DIRS = [".next/server"];

/** A floor, so an empty scan cannot report success. */
const MIN_FILES = 20;
const MIN_BYTES = 1_000_000;

interface Pattern {
  readonly name: string;
  readonly test: RegExp;
}

/** Server-only configuration: a NAME here means a credential can be inlined. */
const SERVER_ONLY_NAMES = [
  "TYPESAFE_API_KEY",
  "AI_GATEWAY_API_KEY",
  "JEV_TOKEN",
  "JEV_ENDPOINT",
  "JEV_MODEL",
  "JEV_TIMEOUT_MS",
  "JEV_MIN_CONFIDENCE",
  "JEV_RATE_LIMIT_ID",
  "VERCEL_OIDC_TOKEN",
];

/** Endpoints only the relay may know. */
const UPSTREAM_HOSTS = ["api.typesafe.ai", "ai-gateway.vercel.sh"];

/** Secret-value patterns: the values themselves are added at runtime. */
const PATTERNS: readonly Pattern[] = [
  ...SERVER_ONLY_NAMES.map((name) => ({
    name: `server-only variable name ${name}`,
    test: new RegExp(`\\b${name}\\b`),
  })),
  ...UPSTREAM_HOSTS.map((host) => ({
    name: `upstream host ${host}`,
    test: new RegExp(host.replace(/\./g, "\\.")),
  })),
  {
    name: "credential shape (sk-/vck_/Bearer)",
    test: /\b(?:sk-[A-Za-z0-9_-]{8,}|vck_[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~-]{12,})\b/,
  },
];

/** Files a scanned directory may report on. */
function walk(dir: string, filter: (file: string) => boolean): string[] {
  const found: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && filter(full)) {
        found.push(full);
      }
    }
  }
  return found;
}

function publicDocuments(): string[] {
  const targets: string[] = [];
  for (const dir of PUBLIC_DOCS) {
    const full = path.join(ROOT, dir);
    if (!existsSync(full)) {
      continue;
    }
    targets.push(...walk(full, (file) => /\.(html|rsc|json)$/.test(file)));
  }
  return targets;
}

function scannedTargets(): string[] {
  const targets: string[] = [];
  for (const dir of CLIENT_DIRS) {
    const full = path.join(ROOT, dir);
    if (existsSync(full)) {
      targets.push(...walk(full, () => true));
    }
  }
  targets.push(...publicDocuments());
  for (const dir of PUBLIC_ASSETS) {
    const full = path.join(ROOT, dir);
    if (existsSync(full)) {
      targets.push(...walk(full, () => true));
    }
  }
  return targets;
}

/**
 * The configured secret VALUES, read but never printed. `.env.local` is where
 * a local run keeps them and is gitignored; `next start` reads it, a plain
 * node/tsx CLI does not, which is why it is read here explicitly.
 */
function configuredSecrets(): { name: string; value: string }[] {
  const names = ["TYPESAFE_API_KEY", "AI_GATEWAY_API_KEY", "JEV_TOKEN", "VERCEL_OIDC_TOKEN"];
  const values = new Map<string, string>();
  const envFile = path.join(ROOT, ".env.local");
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match !== null) {
        values.set(match[1], match[2].trim().replace(/^["']|["']$/g, ""));
      }
    }
  }
  for (const name of names) {
    const fromEnv = process.env[name]?.trim();
    if (fromEnv !== undefined && fromEnv !== "") {
      values.set(name, fromEnv);
    }
  }
  return names
    .map((name) => ({ name, value: values.get(name) ?? "" }))
    .filter((entry) => entry.value.length >= 8);
}

interface Finding {
  readonly file: string;
  readonly pattern: string;
}

function scan(files: readonly string[], patterns: readonly Pattern[]): {
  findings: Finding[];
  bytes: number;
} {
  const findings: Finding[] = [];
  let bytes = 0;
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    bytes += Buffer.byteLength(content, "utf8");
    for (const pattern of patterns) {
      if (pattern.test.test(content)) {
        findings.push({ file: path.relative(ROOT, file), pattern: pattern.name });
      }
    }
  }
  return { findings, bytes };
}

/** The matcher must flag what it exists to flag, or its green means nothing. */
function selfTest(): void {
  const decoys: readonly string[] = [
    "TYPESAFE_API_KEY=x",
    "JEV_RATE_LIMIT_ID=x",
    "https://api.typesafe.ai/v1/systemone",
    "Bearer abcdefghijklmnop",
    "sk-liveabcdefghijkl",
  ];
  for (const decoy of decoys) {
    const flagged = PATTERNS.some((pattern) => pattern.test.test(decoy));
    if (!flagged) {
      throw new Error(`matcher self-test failed: a decoy went unflagged (${decoys.indexOf(decoy)})`);
    }
  }
}

function main(): void {
  const files = scannedTargets();
  if (files.length < MIN_FILES) {
    throw new Error(
      `scanned only ${files.length} files: is this a real \`pnpm build\` output? Run \`pnpm build\` first`,
    );
  }

  const secrets = configuredSecrets();
  const patterns: Pattern[] = [
    ...PATTERNS,
    ...secrets.map((entry) => ({
      // The NAME only. The value never reaches a string this tool prints.
      name: `configured value of ${entry.name}`,
      test: new RegExp(entry.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    })),
  ];

  selfTest();

  const client = scan(files, patterns);
  if (client.bytes < MIN_BYTES) {
    throw new Error(
      `scanned ${client.bytes} bytes: too little to call this a client-bundle scan (\`pnpm build\` first)`,
    );
  }

  // The control: the same patterns over the server chunks, where the names DO
  // belong. If nothing matches there either, the scan is not reading real
  // content and the green above would be meaningless.
  const controlFiles = CONTROL_DIRS.flatMap((dir) => {
    const full = path.join(ROOT, dir);
    return existsSync(full) ? walk(full, (file) => file.endsWith(".js")) : [];
  });
  const controlMatches = new Set(
    controlFiles
      .flatMap((file) => PATTERNS.filter((pattern) => pattern.test.test(readFileSync(file, "utf8"))))
      .map((pattern) => pattern.name),
  );
  if (controlMatches.size < 5) {
    throw new Error(
      `control failed: only ${controlMatches.size} of ${PATTERNS.length} patterns matched the server output, so this scan is not reading a production build`,
    );
  }

  const clientChunkFiles = files.filter((file) => path.relative(ROOT, file).startsWith(".next/static"));
  const documents = publicDocuments();
  console.log(`client-bundle secret scan`);
  console.log(`  scanned ${files.length} files, ${(client.bytes / 1024).toFixed(0)} KB`);
  console.log(`    ${clientChunkFiles.length} client chunks/assets under .next/static`);
  console.log(`    ${documents.length} prerendered public documents under .next/server/app`);
  console.log(`  configured secrets searched as values: ${secrets.map((entry) => entry.name).join(", ") || "none available"}`);
  console.log(`  patterns: ${patterns.length} (names, hosts, shapes, values)`);
  console.log(`  control: ${controlMatches.size}/${PATTERNS.length} patterns match the SERVER chunks (where they belong)`);

  if (client.findings.length > 0) {
    for (const finding of client.findings) {
      // File and pattern names only: never the matched material.
      console.error(`  FAIL ${finding.file} matched ${finding.pattern}`);
    }
    throw new Error(`${client.findings.length} match(es) in browser-fetchable output`);
  }

  console.log(`  secret boundary: PASS - no secret-shaped material, no server-only config names, no upstream host`);
}

try {
  main();
} catch (error: unknown) {
  console.error(`client-bundle secret scan FAILED: ${error instanceof Error ? error.message : "unknown failure"}`);
  process.exitCode = 1;
}
