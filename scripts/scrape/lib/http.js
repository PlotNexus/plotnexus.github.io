export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A perfectly fixed interval between requests (always exactly 5000ms, say)
// is itself a recognisable bot fingerprint for anti-abuse systems — real
// browsing/traffic doesn't arrive on a metronome. Jittering the delay
// randomly within +/-`jitter` of the base keeps the average pacing the
// same while avoiding that dead giveaway.
export function jitteredDelay(baseMs, jitter = 0.4) {
  const min = baseMs * (1 - jitter);
  const max = baseMs * (1 + jitter);
  return Math.round(min + Math.random() * (max - min));
}

export function sleepJittered(baseMs, jitter = 0.4) {
  return sleep(jitteredDelay(baseMs, jitter));
}

export function createFetcher({ userAgent, retries = 4, retryBaseDelayMs = 8000, acceptLanguage = "pt-PT,pt;q=0.9" }) {
  return async function fetchHtml(url) {
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
          headers: {
            "User-Agent": userAgent,
            "Accept-Language": acceptLanguage,
          },
        });
      } catch (err) {
        if (attempt === retries) {
          throw new Error(`${url}: falha de rede persistente após ${retries} tentativas (${err.message})`);
        }
        const wait = jitteredDelay(retryBaseDelayMs * (attempt + 1));
        console.warn(`[http] falha de rede em ${url} (${err.message}), a aguardar ${wait}ms antes de repetir`);
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
