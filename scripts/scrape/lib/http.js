export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        const wait = retryBaseDelayMs * (attempt + 1);
        console.warn(`[http] falha de rede em ${url} (${err.message}), a aguardar ${wait}ms antes de repetir`);
        await sleep(wait);
        continue;
      }

      if (res.status === 429) {
        if (attempt === retries) {
          throw new Error(`${url} continua a responder 429 depois de ${retries} tentativas`);
        }
        const wait = retryBaseDelayMs * (attempt + 1);
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
