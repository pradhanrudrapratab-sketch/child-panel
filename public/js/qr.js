/* Tiny dependency-free QR Code encoder (byte mode, ECC level M, versions 1-10). Used to draw UPI payment QR codes in the browser. */
(function (root) {
  'use strict';
  var ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  var NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  function rawModules(v) {
    var r = (16 * v + 128) * v + 64;
    if (v >= 2) { var n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; }
    return r;
  }
  function dataCodewords(v) { return Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[v] * NUM_BLOCKS[v]; }
  /* GF(256) */
  var EXP = new Array(512), LOG = new Array(256);
  (function () { var x = 1; for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; } for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
  function gmul(a, b) { return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]; }
  function rsGen(deg) { var p = [1]; for (var i = 0; i < deg; i++) { var q = new Array(p.length + 1).fill(0); for (var j = 0; j < p.length; j++) { q[j] ^= p[j]; q[j + 1] ^= gmul(p[j], EXP[i]); } p = q; } return p; }
  function rsRem(data, deg) {
    var gen = rsGen(deg), rem = new Array(deg).fill(0);
    data.forEach(function (b) { var f = b ^ rem[0]; rem.shift(); rem.push(0); for (var i = 0; i < deg; i++) rem[i] ^= gmul(gen[i + 1], f); });
    return rem;
  }
  function utf8(s) { return Array.prototype.slice.call(new TextEncoder().encode(s)); }

  function encode(text) {
    var bytes = utf8(text), ver = 0;
    for (var v = 1; v <= 10; v++) { var cap = 4 + (v < 10 ? 8 : 16) + 8 * bytes.length; if (cap <= dataCodewords(v) * 8) { ver = v; break; } }
    if (!ver) throw new Error('QR data too long');
    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); bytes.forEach(function (b) { put(b, 8); });
    var capBits = dataCodewords(ver) * 8;
    put(0, Math.min(4, capBits - bits.length)); while (bits.length % 8) bits.push(0);
    for (var pad = 0xEC; bits.length < capBits; pad ^= 0xEC ^ 0x11) put(pad, 8);
    var data = []; for (var i = 0; i < bits.length; i += 8) { var b = 0; for (var k = 0; k < 8; k++) b = (b << 1) | bits[i + k]; data.push(b); }

    var nb = NUM_BLOCKS[ver], eccLen = ECC_PER_BLOCK[ver], raw = Math.floor(rawModules(ver) / 8);
    var shortN = nb - raw % nb, shortLen = Math.floor(raw / nb), blocks = [], pos = 0;
    for (i = 0; i < nb; i++) {
      var d = data.slice(pos, pos + shortLen - eccLen + (i < shortN ? 0 : 1)); pos += d.length;
      blocks.push({ d: d, e: rsRem(d, eccLen) });
    }
    var out = [];
    for (i = 0; i < shortLen + 1; i++) blocks.forEach(function (bl, j) { if (i < bl.d.length) out.push(bl.d[i]); });
    for (i = 0; i < eccLen; i++) blocks.forEach(function (bl) { out.push(bl.e[i]); });

    var size = ver * 4 + 17, mod = [], fn = [];
    for (i = 0; i < size; i++) { mod.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
    function setFn(x, y, dark) { mod[y][x] = !!dark; fn[y][x] = true; }
    for (i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    function finder(cx, cy) { for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) { var dist = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy; if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4); } }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    var al = [];
    if (ver > 1) { var na = Math.floor(ver / 7) + 2, step = Math.ceil((ver * 4 + 4) / (na * 2 - 2)) * 2; al = [6]; for (var p = size - 7; al.length < na; p -= step) al.splice(1, 0, p); }
    al.forEach(function (ay, a) { al.forEach(function (ax, b) {
      if ((a === 0 && b === 0) || (a === 0 && b === al.length - 1) || (a === al.length - 1 && b === 0)) return;
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) setFn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }); });
    function fmt(mask) {
      var d = (0 << 3) | mask, r = d; for (var k = 0; k < 10; k++) r = (r << 1) ^ ((r >>> 9) * 0x537);
      var f = ((d << 10) | r) ^ 0x5412; function bit(n) { return ((f >>> n) & 1) !== 0; }
      for (k = 0; k <= 5; k++) setFn(8, k, bit(k)); setFn(8, 7, bit(6)); setFn(8, 8, bit(7)); setFn(7, 8, bit(8)); for (k = 9; k < 15; k++) setFn(14 - k, 8, bit(k));
      for (k = 0; k < 8; k++) setFn(size - 1 - k, 8, bit(k)); for (k = 8; k < 15; k++) setFn(8, size - 15 + k, bit(k)); setFn(8, size - 8, true);
    }
    fmt(0);
    if (ver >= 7) { var r = ver; for (i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25); var vb = (ver << 12) | r; for (i = 0; i < 18; i++) { var c = ((vb >>> i) & 1) !== 0, a2 = size - 11 + i % 3, b2 = Math.floor(i / 3); setFn(a2, b2, c); setFn(b2, a2, c); } }
    var bi = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) for (var j = 0; j < 2; j++) {
        var x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && bi < out.length * 8) { mod[y][x] = ((out[bi >>> 3] >>> (7 - (bi & 7))) & 1) !== 0; bi++; }
      }
    }
    var MASKS = [function (x, y) { return (x + y) % 2 === 0; }, function (x, y) { return y % 2 === 0; }, function (x) { return x % 3 === 0; }, function (x, y) { return (x + y) % 3 === 0; },
      function (x, y) { return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; }, function (x, y) { return x * y % 2 + x * y % 3 === 0; }, function (x, y) { return (x * y % 2 + x * y % 3) % 2 === 0; }, function (x, y) { return ((x + y) % 2 + x * y % 3) % 2 === 0; }];
    function apply(m) { for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x]; }
    function penalty() {
      var s = 0, dark = 0, x, y, run;
      for (y = 0; y < size; y++) { run = 1; for (x = 1; x < size; x++) { if (mod[y][x] === mod[y][x - 1]) { run++; if (run === 5) s += 3; else if (run > 5) s++; } else run = 1; } }
      for (x = 0; x < size; x++) { run = 1; for (y = 1; y < size; y++) { if (mod[y][x] === mod[y - 1][x]) { run++; if (run === 5) s += 3; else if (run > 5) s++; } else run = 1; } }
      for (y = 0; y < size - 1; y++) for (x = 0; x < size - 1; x++) if (mod[y][x] === mod[y][x + 1] && mod[y][x] === mod[y + 1][x] && mod[y][x] === mod[y + 1][x + 1]) s += 3;
      for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (mod[y][x]) dark++;
      return s + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    }
    var best = 0, bestP = Infinity;
    for (var m = 0; m < 8; m++) { apply(m); fmt(m); var pp = penalty(); if (pp < bestP) { bestP = pp; best = m; } apply(m); }
    apply(best); fmt(best);
    return mod;
  }

  /** Returns an <svg> element string-safe DOM node for the given text. */
  function toSvg(text, px) {
    var m = encode(text), n = m.length, q = 4, NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + (n + q * 2) + ' ' + (n + q * 2)); svg.setAttribute('width', px || 220); svg.setAttribute('height', px || 220);
    svg.setAttribute('shape-rendering', 'crispEdges'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Payment QR code');
    var bg = document.createElementNS(NS, 'rect'); bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%'); bg.setAttribute('fill', '#fff'); svg.appendChild(bg);
    var d = ''; for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) if (m[y][x]) d += 'M' + (x + q) + ' ' + (y + q) + 'h1v1h-1z';
    var path = document.createElementNS(NS, 'path'); path.setAttribute('d', d); path.setAttribute('fill', '#000'); svg.appendChild(path);
    return svg;
  }
  root.QR = { encode: encode, toSvg: toSvg };
  if (typeof module !== 'undefined') module.exports = root.QR;
})(typeof window !== 'undefined' ? window : globalThis);
