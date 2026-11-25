'use strict';
// All money is integer paise (INR). No floating point arithmetic anywhere.
class MoneyError extends Error {}

function parsePaise(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyError('Invalid amount');
    input = String(input);
  }
  if (typeof input !== 'string') throw new MoneyError('Invalid amount');
  const s = input.trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) throw new MoneyError('Amount must be a number with at most 2 decimals');
  const [whole, frac = ''] = s.split('.');
  return parseInt(whole, 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
}

function formatPaise(p) {
  const neg = p < 0; const a = Math.abs(p);
  return (neg ? '-' : '') + Math.floor(a / 100) + '.' + String(a % 100).padStart(2, '0');
}

module.exports = { parsePaise, formatPaise, MoneyError };
