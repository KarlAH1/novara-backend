export async function fetchWithTimeout(url, options = {}, { timeoutMs = 8000, retries = 0 } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const externalSignal = options.signal;
    const relayAbort = () => controller.abort(externalSignal.reason);
    const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
    externalSignal?.addEventListener("abort", relayAbort, { once: true });

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (attempt < retries && [429, 502, 503, 504].includes(response.status)) {
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1) + Math.random() * 150));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (externalSignal?.aborted || attempt >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1) + Math.random() * 150));
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", relayAbort);
    }
  }

  throw lastError;
}
