export async function fetchProvider(provider, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw new Error(`${provider}_timeout`);
    }
    throw new Error(`${provider}_network_error`);
  } finally {
    clearTimeout(timer);
  }
}
