// Build-time patch: allow any HTTP(S) origin for the DeepSeek account login.
//
// dsh 0.2.2-rc.1 ships a hard-coded loopback-only check for the OAuth callback
// origin (loginOrigin). That is why "Sign in" fails instantly when the UI is
// opened through a public IP / reverse proxy. This patch removes that check and
// accepts any HTTP(S) origin supplied by the browser.
//
// This only removes the dsh-side check. The DeepSeek Platform must also accept
// the public redirect_uri; the upstream docs still describe loopback / SSH
// forwarding as the supported login path. If the Platform rejects the public
// URI, auth_init fails and the normal local-proxy / SSH tunnel remains the
// fallback.
//
// Security note: any origin can now receive the OAuth code. PKCE still protects
// the code-for-token exchange (the verifier stays on the server), but this is
// an open-redirect surface. Use it only on a deployment you control.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const MARK = 'remote-oauth: any HTTP(S) origin'
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
  '\t// remote-oauth: any HTTP(S) origin is accepted as the callback origin.',
  '\tif ((url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "") return url.origin;',
  '\tthrow new PlatformAuthError("protocol");',
  '}',
  '//#endregion',
].join('\n')

writeFileSync(file, src.replace(anchor, patched))
console.log('[remote-oauth] patched loginOrigin to accept any HTTP(S) origin')
