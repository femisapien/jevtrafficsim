import type { NextConfig } from "next";
import { execFileSync } from "node:child_process";

function buildCommitSha(): string {
  const vercel = process.env.VERCEL_GIT_COMMIT_SHA;
  if (vercel && /^[a-f0-9]{40}$/i.test(vercel)) return vercel;
  try {
    const local = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[a-f0-9]{40}$/i.test(local) ? local : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Conservative global headers (security pass).
 *
 * Every one of these is a statement about HOW the response may be used, not a
 * restriction on the app's own code, which is why none of them can change what
 * the product does:
 *
 *   X-Content-Type-Options   no MIME sniffing: a browser must not decide a
 *                            JavaScript-typed asset is HTML (or vice versa).
 *   Referrer-Policy          cross-origin requests carry the origin only, never
 *                            the path — this app's paths carry no secrets, and
 *                            this keeps it that way by default.
 *   Permissions-Policy       camera, microphone and geolocation are OFF. The app
 *                            uses none of them (checked: no navigator.geolocation,
 *                            no getUserMedia anywhere in the tree), so denying
 *                            them cannot break a feature; it removes them from
 *                            the reach of anything that ever gets injected.
 *   frame-ancestors 'none'   the app may never be framed (clickjacking). Also
 *   + X-Frame-Options: DENY  sent as X-Frame-Options, which older browsers obey.
 *                            Nothing in this app embeds or is embedded in a
 *                            frame: there is no <iframe> in the tree, and the
 *                            only tests that drive it are real top-level pages.
 *
 * ## The full Content-Security-Policy: deliberately NOT added
 *
 * A strict nonce-based CSP needs a nonce PER REQUEST, which needs dynamic
 * rendering: every prerendered page's HTML is built once at build time and can
 * never carry this request's nonce, so a nonce CSP would require forcing every
 * page dynamic (a rendering/architecture change, not a header). Without a
 * nonce, Next's own bootstrap and RSC payload scripts (`self.__next_f.push(...)`)
 * are inline, so the only CSP that would load the app is one with
 * `script-src 'unsafe-inline'` — a policy weaker than the header's cost, and one
 * that would say "protected" while permitting exactly the injection it exists to
 * stop. The honest choice is to ship the frame protection above (real, cheap and
 * provable) and to NOT ship a CSP that has not been proven against Next +
 * MapLibre + its blob: workers in a real browser. If a future pass proves one,
 * frame-ancestors stays here and the rest joins it.
 */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
];

const nextConfig: NextConfig = {
  // A commit identifier is public, not a credential. Freeze it into the build
  // so a preview/prod diagnosis can identify the code actually deployed.
  env: { BUILD_COMMIT_SHA: buildCommitSha() },
  /**
   * Every route, including the HTML pages, the client chunks and the relay's
   * JSON — one list, so no surface can be left out by a matcher that forgot a
   * path. Only the framework's own immutable asset directories are included
   * WITHOUT exception because they cost nothing to stamp.
   */
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
