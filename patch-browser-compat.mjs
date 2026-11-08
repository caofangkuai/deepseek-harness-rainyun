// Build-time browser compatibility patch for the bundled dsh Web UI.
//
// dsh 0.2.2-rc.1 ships a frontend built for modern browsers:
//   - class static initialization blocks (`static { ... }`, Chrome 94+)
//   - Object.hasOwn (Chrome 93+)
//   - Array.prototype.at / String.prototype.at (Chrome 92+)
//   - URL.canParse (Chrome 120+)
//   - crypto.randomUUID (Chrome 92+)
//
// Older WebViews (for example the Android WebView 91.0.4472.114) fail to parse
// the static blocks, so the SPA never boots and the page stays blank after
// authentication. This script transpiles every bundled JS asset to Chrome 90
// syntax with esbuild and injects a classic <script> with runtime polyfills
// before the module bundle. Modern browsers keep their native implementations.
//
// esbuild is installed in the build stage under /opt/esbuild and is not copied
// into the runtime stage.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const dshRequire = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json')
const esbuildRequire = createRequire('/opt/esbuild/resolve.js')
const { transformSync } = esbuildRequire('esbuild')

const indexPath = dshRequire.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
const distDir = indexPath.slice(0, indexPath.lastIndexOf('/'))
const assetsDir = join(distDir, 'assets')

const MARK = 'dsh-docker: browser compat polyfills'

const POLYFILL = `<script>
/* ${MARK} for Chrome <92 / old WebViews */
(function () {
  try {
    if (typeof Object.hasOwn !== 'function') {
      Object.defineProperty(Object, 'hasOwn', {
        value: function (object, property) {
          if (object === null || typeof object === 'undefined') {
            throw new TypeError('Cannot convert undefined or null to object');
          }
          return Object.prototype.hasOwnProperty.call(Object(object), property);
        },
        configurable: true,
        writable: true
      });
    }
    function at(index) {
      var object = Object(this);
      var length = object.length >>> 0;
      var relative = Number(index);
      if (relative !== relative) relative = 0;
      var k = relative < 0 ? Math.ceil(relative) : Math.floor(relative);
      if (k < 0) k += length;
      if (k < 0 || k >= length) return undefined;
      return object[k];
    }
    if (typeof Array.prototype.at !== 'function') {
      Object.defineProperty(Array.prototype, 'at', { value: at, configurable: true, writable: true });
    }
    if (typeof String.prototype.at !== 'function') {
      Object.defineProperty(String.prototype, 'at', { value: at, configurable: true, writable: true });
    }
    if (typeof URL !== 'undefined' && typeof URL.canParse !== 'function') {
      URL.canParse = function canParse(url, base) {
        try { new URL(url, base); return true; } catch (e) { return false; }
      };
    }
    if (typeof URL !== 'undefined' && typeof URL.parse !== 'function') {
      URL.parse = function parse(url, base) {
        try { return new URL(url, base); } catch (e) { return null; }
      };
    }
    if (typeof Promise.withResolvers !== 'function') {
      Promise.withResolvers = function withResolvers() {
        var resolve, reject;
        var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
        return { promise: promise, resolve: resolve, reject: reject };
      };
    }
    if (typeof Promise.try !== 'function') {
      Promise.try = function tryFn(fn) {
        var args = Array.prototype.slice.call(arguments, 1);
        return new Promise(function (resolve) { resolve(fn.apply(undefined, args)); });
      };
    }
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any !== 'function') {
      AbortSignal.any = function any(signals) {
        var controller = new AbortController();
        var list = Array.from(signals);
        for (var i = 0; i < list.length; i++) {
          var signal = list[i];
          if (signal.aborted) { controller.abort(signal.reason); return controller.signal; }
          signal.addEventListener('abort', function () { controller.abort(this.reason); }, { once: true });
        }
        return controller.signal;
      };
    }
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
      AbortSignal.timeout = function timeout(ms) {
        var controller = new AbortController();
        setTimeout(function () {
          var reason;
          try { reason = new DOMException('The operation timed out.', 'TimeoutError'); }
          catch (e) { reason = new Error('The operation timed out.'); }
          controller.abort(reason);
        }, ms);
        return controller.signal;
      };
    }
    if (typeof Array.prototype.findLast !== 'function') {
      Object.defineProperty(Array.prototype, 'findLast', {
        value: function findLast(callback, thisArg) {
          for (var i = this.length - 1; i >= 0; i--) {
            if (callback.call(thisArg, this[i], i, this)) return this[i];
          }
          return undefined;
        },
        configurable: true, writable: true
      });
    }
    if (typeof Array.prototype.findLastIndex !== 'function') {
      Object.defineProperty(Array.prototype, 'findLastIndex', {
        value: function findLastIndex(callback, thisArg) {
          for (var i = this.length - 1; i >= 0; i--) {
            if (callback.call(thisArg, this[i], i, this)) return i;
          }
          return -1;
        },
        configurable: true, writable: true
      });
    }
    if (typeof Array.prototype.toSorted !== 'function') {
      Object.defineProperty(Array.prototype, 'toSorted', {
        value: function toSorted(compareFn) { return this.slice().sort(compareFn); },
        configurable: true, writable: true
      });
    }
    if (typeof Array.prototype.toReversed !== 'function') {
      Object.defineProperty(Array.prototype, 'toReversed', {
        value: function toReversed() { return this.slice().reverse(); },
        configurable: true, writable: true
      });
    }
    if (typeof Array.prototype.toSpliced !== 'function') {
      Object.defineProperty(Array.prototype, 'toSpliced', {
        value: function toSpliced() {
          var copy = this.slice();
          copy.splice.apply(copy, arguments);
          return copy;
        },
        configurable: true, writable: true
      });
    }
    if (typeof Array.prototype.with !== 'function') {
      Object.defineProperty(Array.prototype, 'with', {
        value: function withValue(index, value) {
          var copy = this.slice();
          var i = Number(index);
          if (i < 0) i += copy.length;
          if (i < 0 || i >= copy.length) throw new RangeError('Invalid index');
          copy[i] = value;
          return copy;
        },
        configurable: true, writable: true
      });
    }
    if (typeof Object.groupBy !== 'function') {
      Object.groupBy = function groupBy(items, callback) {
        var out = Object.create(null);
        var index = 0;
        for (var item of items) {
          var key = callback(item, index++);
          if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = [];
          out[key].push(item);
        }
        return out;
      };
    }
    if (typeof Map.groupBy !== 'function') {
      Map.groupBy = function groupBy(items, callback) {
        var out = new Map();
        var index = 0;
        for (var item of items) {
          var key = callback(item, index++);
          if (!out.has(key)) out.set(key, []);
          out.get(key).push(item);
        }
        return out;
      };
    }
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
      var getBytes = (typeof crypto.getRandomValues === 'function')
        ? function (n) { var b = new Uint8Array(n); crypto.getRandomValues(b); return b; }
        : function (n) { var b = new Uint8Array(n); for (var i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256); return b; };
      crypto.randomUUID = function randomUUID() {
        var b = getBytes(16);
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        var h = '';
        for (var i = 0; i < 16; i++) {
          h += (i === 4 || i === 6 || i === 8 || i === 10 ? '-' : '') + b[i].toString(16).padStart(2, '0');
        }
        return h;
      };
    }
  } catch (e) { /* never break the page over a polyfill */ }
})();
</script>`

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(file))
    else if (file.endsWith('.js')) out.push(file)
  }
  return out
}

const files = walk(assetsDir)
let transformed = 0
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const result = transformSync(source, {
    target: 'chrome90',
    format: 'esm',
    minify: true,
    legalComments: 'none',
    loader: 'js',
  })
  if (result.code !== source) {
    writeFileSync(file, result.code)
    transformed++
  }
}
console.log(`[browser-compat] transpiled ${transformed}/${files.length} JS assets to Chrome 90 syntax`)

const html = readFileSync(indexPath, 'utf8')
if (html.includes(MARK)) {
  console.log('[browser-compat] polyfills already present, skipping injection')
} else {
  const marker = html.includes('<head>') ? '<head>' : '</head>'
  const inserted = marker === '<head>'
    ? html.replace('<head>', '<head>\n' + POLYFILL)
    : html.replace('</head>', POLYFILL + '\n</head>')
  if (inserted === html) throw new Error('[browser-compat] could not inject polyfills into index.html')
  writeFileSync(indexPath, inserted)
  console.log('[browser-compat] injected runtime polyfills into', indexPath)
}
