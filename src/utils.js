export function json(data, status=200, extra={}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra }
  });
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function median(values) {
  const a = values.filter(Number.isFinite).sort((x,y)=>x-y);
  if (!a.length) return null;
  const m = Math.floor(a.length/2);
  return a.length % 2 ? a[m] : (a[m-1]+a[m])/2;
}

export async function fetchJson(url, options={}, timeoutMs=8500) {
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    return { ok: response.ok, status: response.status, body, latencyMs: Date.now()-started };
  } finally {
    clearTimeout(timer);
  }
}

export function iso(tsMs=Date.now()) {
  return new Date(tsMs).toISOString();
}

export function formatWAT(tsMs) {
  return new Date(tsMs).toLocaleTimeString("en-US", {
    timeZone: "Africa/Lagos",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  });
}

export function round(n, digits=5) {
  const p = 10 ** digits;
  return Math.round(n*p)/p;
}
