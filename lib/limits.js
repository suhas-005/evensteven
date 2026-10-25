export const LIMITS = {
  bodyParse: 1_572_864, bodyPut: 524_288, bodyJson: 65_536,
  tripName: 60, memberName: 40, title: 200, itemName: 100, instruction: 500,
  money: 1e9, weight: 10, percent: 100, roundOff: 100,
  members: 50, bills: 500, items: 100,
};

export function clamp(n, lo, hi) {
  if (n === null || n === undefined || n === '') return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.min(hi, Math.max(lo, v));
}

export function str(v, max) {
  return String(v ?? '').trim().slice(0, max);
}

export function contentLengthProblem(request, max) {
  const raw = request.headers.get('content-length');
  if (raw === null || raw === '') return 'Request needs a Content-Length header';
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 'Request needs a valid Content-Length header';
  if (n > max) return `Request too large, max ${Math.round(max / 1024)} KB`;
  return null;
}
