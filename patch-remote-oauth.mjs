// Build-time patch: let the DeepSeek account login use a public origin.
//
// dsh 0.2.2-rc.1 ships a hard-coded loopback-only check for the OAuth callback
// origin (loginOrigin). That is why "Sign in" fails instantly when the UI is
// opened through a public IP / reverse proxy. This patch adds an operator
// opt-in: when DSH_PUBLIC_ORIGIN is set to the browser-visible origin (or a
// comma-separated list), that origin is accepted in addition to the original
// loopback origins.
//
// This only removes the dsh-side check. The DeepSeek Platform must also accept
// the public redirect_uri; the upstream docs still describe loopback / SSH
// forwarding as the supported login path. If the Platform rejects the public
// URI, auth_init fails and the normal local-proxy / SSH tunnel remains the
// fallback.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const MARK = 'DSH_PUBLIC_ORIGIN'
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
  '\t// DSH_PUBLIC_ORIGIN: accept the operator-declared public origin(s) too.',
  '\tconst allowed = (typeof process !== "undefined" && process.env.DSH_PUBLIC_ORIGIN ? process.env.DSH_PUBLIC_ORIGIN : "").split(",").map((item) => item.trim()).filter(Boolean);',
  '\tif (allowed.length > 0 && url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "") {',
  '\t\tfor (const item of allowed) {',
  '\t\t\ttry {',
  '\t\t\t\tconst candidate = new URL(item);',
  '\t\t\t\tif (candidate.origin === url.origin) return candidate.origin;',
  '\t\t\t} catch {}',
  '\t\t}',
  '\t}',
  '\tconst explicitPort = /^http:\\/\\/(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):([0-9]+)\\/?$/i.exec(value)?.[1];',
  '\tif (explicitPort === void 0 || Number(explicitPort) === 0 || url.protocol !== "http:" || ![',
  '\t\t"localhost",',
  '\t\t"127.0.0.1",',
  '\t\t"[::1]"',
  '\t].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new PlatformAuthError("protocol");',
  '\treturn `${url.protocol}//${url.hostname}:${Number(explicitPort)}`;',
  '}',
  '//#endregion',
].join('\n')

writeFileSync(file, src.replace(anchor, patched))
console.log('[remote-oauth] patched loginOrigin with DSH_PUBLIC_ORIGIN opt-in')
