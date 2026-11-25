'use strict';
// Colour presets taken from the reference store (store.html PALETTE) + accent helper.
const PALETTE = {
  red: { label: 'Red', accent: '#ff3b3b', accent2: '#ff7a45' }, blue: { label: 'Blue', accent: '#3b82ff', accent2: '#22d3ee' },
  yellow: { label: 'Yellow', accent: '#ffd23f', accent2: '#ff9f1c' }, purple: { label: 'Purple', accent: '#a855f7', accent2: '#ec4899' },
  white: { label: 'White', accent: '#f2f2f2', accent2: '#b8b8c0' }, pink: { label: 'Pink', accent: '#ec4899', accent2: '#f472b6' },
  orange: { label: 'Orange', accent: '#f97316', accent2: '#fbbf24' }, green: { label: 'Green', accent: '#22c55e', accent2: '#84cc16' },
  lime: { label: 'Lime', accent: '#a3e635', accent2: '#4ade80' }, teal: { label: 'Teal', accent: '#14b8a6', accent2: '#22d3ee' },
  cyan: { label: 'Cyan', accent: '#22d3ee', accent2: '#3b82f6' }, indigo: { label: 'Indigo', accent: '#6366f1', accent2: '#a855f7' },
  magenta: { label: 'Magenta', accent: '#d946ef', accent2: '#ec4899' }, gold: { label: 'Gold', accent: '#eab308', accent2: '#f59e0b' },
  crimson: { label: 'Crimson', accent: '#dc2626', accent2: '#f97316' }, slate: { label: 'Slate', accent: '#94a3b8', accent2: '#64748b' },
};
const HEX = /^#[0-9a-fA-F]{6}$/;
function shift(hex) {
  const n = parseInt(hex.slice(1), 16); let r = (n >> 16) / 255; let g = ((n >> 8) & 255) / 255; let b = (n & 255) / 255;
  const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); let h = 0; const l = (mx + mn) / 2; const d = mx - mn;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  h = (h + 30) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s; const x = c * (1 - Math.abs(((h / 60) % 2) - 1)); const m = l - c / 2;
  const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r1) + to(g1) + to(b1);
}
function resolve(v) {
  if (PALETTE[v]) return { key: v, ...PALETTE[v] };
  if (HEX.test(v || '')) return { key: v.toLowerCase(), label: 'Custom', accent: v.toLowerCase(), accent2: shift(v) };
  return { key: 'blue', ...PALETTE.blue };
}
module.exports = { PALETTE, resolve, shift, valid: (v) => !!PALETTE[v] || HEX.test(v || '') };
