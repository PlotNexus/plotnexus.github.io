export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// worker.js's sharding gets each source's national sweep spread across 4
// parallel GitHub Actions jobs — each on its own runner IP — so a source
// like CASA SAPO only ever sees a quarter of the districts, at the usual
// per-request delay, from any single IP. index.js (the unsharded, single-
// process local runner — see run-full-scrape.bat) does the exact same
// per-request delay but from *one* IP working through *every* district
// sequentially, which is a very different, much more sustained request
// pattern from that IP's point of view even though the steady-state
// request rate hasn't changed — and in practice that's enough to trip
// CASA SAPO's rate-limiting far more (confirmed: a real run failed most
// districts with 429s after just the first couple succeeded). index.js
// sets this to slow every delay down uniformly instead; worker.js never
// sets it, so GitHub Actions' sharded runs are unaffected.
function delayMultiplier() {
  const raw = Number(process.env.SCRAPE_QUERY_DELAY_MULTIPLIER);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

// A perfectly fixed interval between requests (always exactly 5000ms, say)
// is itself a recognisable bot fingerprint for anti-abuse systems — real
// browsing/traffic doesn't arrive on a metronome. Jittering the delay
// randomly within +/-`jitter` of the base keeps the average pacing the
// same while avoiding that dead giveaway.
export function jitteredDelay(baseMs, jitter = 0.4) {
  const scaled = baseMs * delayMultiplier();
  const min = scaled * (1 - jitter);
  const max = scaled * (1 + jitter);
  return Math.round(min + Math.random() * (max - min));
}

export function sleepJittered(baseMs, jitter = 0.4) {
  return sleep(jitteredDelay(baseMs, jitter));
}

export function createFetcher({ userAgent, retries = 4, retryBaseDelayMs = 8000, acceptLanguage = "pt-PT,pt;q=0.9" }) {
  // `init` lets a caller override method/headers/body (e.g. RE/MAX's search
  // API is a POST with a JSON body) while still going through the same
  // network-failure/429 retry handling as a plain GET.
  return async function fetchHtml(url, init = {}) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      // Besides HTTP-level 429s, fetch() itself can reject with a network
      // error (connection reset, timeout, etc.) — this happens far more
      // often from GitHub Actions runner IPs than from a residential
      // connection, presumably due to the source's own anti-bot/anti-abuse
      // network filtering. Treat that the same as a 429: back off and retry
      // rather than failing the whole query on a single dropped connection.
      let res;
      try {
        res = await fetch(url, {
          ...init,
          headers: {
            "User-Agent": userAgent,
            "Accept-Language": acceptLanguage,
            ...init.headers,
          },
        });
      } catch (err) {
        // fetch()/undici's own message is just "fetch failed" — the useful
        // part (ECONNRESET, cert validation, DNS, etc.) is nested in
        // err.cause. Surface it too, otherwise every network failure looks
        // identical in the logs regardless of actual cause.
        const detail = err.cause ? `${err.message}: ${err.cause.code || err.cause.message || err.cause}` : err.message;
        if (attempt === retries) {
          throw new Error(`${url}: falha de rede persistente após ${retries} tentativas (${detail})`);
        }
        const wait = jitteredDelay(retryBaseDelayMs * (attempt + 1));
        console.warn(`[http] falha de rede em ${url} (${detail}), a aguardar ${wait}ms antes de repetir`);
        await sleep(wait);
        continue;
      }

      if (res.status === 429) {
        if (attempt === retries) {
          throw new Error(`${url} continua a responder 429 depois de ${retries} tentativas`);
        }
        const wait = jitteredDelay(retryBaseDelayMs * (attempt + 1));
        console.warn(`[http] 429 em ${url}, a aguardar ${wait}ms antes de repetir`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        throw new Error(`${url} respondeu ${res.status}`);
      }

      return res.text();
    }
    throw new Error(`${url}: esgotadas as tentativas`);
  };
}
