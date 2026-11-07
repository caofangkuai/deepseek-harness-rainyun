// Build-time patch: make the DeepSeek account login work behind a public
// origin.
//
// dsh 0.2.2-rc.1 ships a hard-coded loopback-only check for the OAuth callback
// origin (loginOrigin). Two deployment modes are supported here:
//
//   DSH_MANUAL_OAUTH=0 (default)
//     Accept any HTTP(S) origin supplied by the browser (fix3 behaviour).
//     This only removes the dsh-side check: the DeepSeek Platform still has
//     to accept the public redirect_uri. In practice the Platform rejects it
//     at the schema layer, so this mode is useful for inspection / testing.
//
//   DSH_MANUAL_OAUTH=1
//     Loopback callers (127.0.0.1 / localhost / [::1], e.g. SSH forwarding or
//     the bundled local-proxy.mjs) keep their origin. Non-loopback callers are
//     forced to http://127.0.0.1:DSH_INTERNAL_PORT, which the Platform accepts.
//     The browser cannot reach that loopback URL, so the auth gate serves a
//     "paste the callback URL" page and completes the callback server-side.
//
// Security note: in default mode any origin can receive the OAuth code. PKCE
// still protects the code-for-token exchange (the verifier stays on the
// server), but this is an open-redirect surface. Use it only on a deployment
// you control.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const MARK = 'remote-oauth: manual loopback callback'
const OLD_MARK = 'remote-oauth: any HTTP(S) origin'
const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json')
const file = require.resolve('@deepseek-ai/dsh-deepseek-account-platform')
const src = readFileSync(file, 'utf8')

if (src.includes(MARK)) {
  console.log('[remote-oauth] already patched, skipping')
  process.exit(0)
}

const anchor = /function loginOrigin\(value\) \{[\s\S]*?\n\}\n\/\/#endregion/
if (!anchor.test(src)) throw new Error('[remote-oauth] anchor not found in ' + file)

const patched = [
  'function loginOrigin(value) {',
  '\tlet url;',
  '\ttry {',
  '\t\turl = new URL(value);',
  '\t} catch {',
  '\t\tthrow new PlatformAuthError("protocol");',
  '\t}',
  '\t// remote-oauth: manual loopback callback',
  '\tif ((url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "") {',
  '\t\tconst loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";',
  '\t\tif (loopback) return url.origin;',
  '\t\tif (process.env.DSH_MANUAL_OAUTH === "1") return `http://127.0.0.1:${process.env.DSH_INTERNAL_PORT || "3081"}`;',
  '\t\treturn url.origin;',
  '\t}',
  '\tthrow new PlatformAuthError("protocol");',
  '}',
  '//#endregion',
].join('\n')

writeFileSync(file, src.replace(anchor, patched))
console.log(src.includes(OLD_MARK)
  ? '[remote-oauth] replaced the any-origin patch with the manual loopback callback patch'
  : '[remote-oauth] patched loginOrigin (manual loopback callback; DSH_MANUAL_OAUTH=1 forces loopback)')
