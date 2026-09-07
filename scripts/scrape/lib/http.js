export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createFetcher({ userAgent, retries = 4, retryBaseDelayMs = 8000, acceptLanguage = "pt-PT,pt;q=0.9" }) {
  return async function fetchHtml(url) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetch(url, {
        headers: {
          "User-Agent": userAgent,
          "Accept-Language": acceptLanguage,
        },
      });

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
