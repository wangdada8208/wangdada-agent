const MODEL_NAME = "@cf/baai/bge-m3";
const VECTOR_DIMENSIONS = 1024;
const TARGET_CHUNK_LENGTH = 1200;
const CHUNK_OVERLAP = 150;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_QUERY_LENGTH = 4096;
const MAX_METADATA_BYTES = 32 * 1024;
const MAX_CONTEXT_CHARS = 6000;
const MAX_SEARCH_RESULTS = 20;
const MAX_SEARCH_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOUNDARY_CHARS = new Set(["。", "！", "？", "；", ";", "\n"]);

class KnowledgeError extends Error {
  constructor(code, status = 500, cause = null) {
    super(code);
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function timeoutMs(env) {
  const value = Number(env?.KNOWLEDGE_TIMEOUT_MS ?? env?.AI_TIMEOUT_MS ?? env?.SERVICE_TIMEOUT_MS);
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1, Math.min(120_000, Math.trunc(value)));
}

function withTimeout(promise, code, milliseconds) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new KnowledgeError(code, 504)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function parseJsonBody(request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new KnowledgeError("request_too_large", 413);
  }
  const text = await request.text();
  if (byteLength(text) > MAX_BODY_BYTES) throw new KnowledgeError("request_too_large", 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new KnowledgeError("invalid_json", 400);
  }
}

function requireSupabase(env, helpers) {
  if (typeof helpers?.supabaseRequest === "function") return;
  if (env?.SUPABASE_URL && env?.SUPABASE_SERVICE_ROLE_KEY) return;
  throw new KnowledgeError("knowledge_not_configured", 503);
}

function requireAI(env) {
  if (env?.AI && typeof env.AI.run === "function") return;
  throw new KnowledgeError("knowledge_not_configured", 503);
}

function validateMetadata(metadata) {
  if (metadata === undefined) return {};
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new KnowledgeError("invalid_metadata", 400);
  }
  const serialized = JSON.stringify(metadata);
  if (byteLength(serialized) > MAX_METADATA_BYTES) {
    throw new KnowledgeError("metadata_too_large", 413);
  }
  return metadata;
}

function chunkText(value) {
  const chars = Array.from(value);
  const chunks = [];
  let start = 0;
  while (start < chars.length) {
    const rawEnd = Math.min(start + TARGET_CHUNK_LENGTH, chars.length);
    let end = rawEnd;
    if (rawEnd < chars.length) {
      const minimumEnd = start + Math.floor(TARGET_CHUNK_LENGTH * 0.55);
      for (let index = rawEnd - 1; index >= minimumEnd; index -= 1) {
        if (BOUNDARY_CHARS.has(chars[index])) {
          end = index + 1;
          break;
        }
      }
    }
    const chunk = chars.slice(start, end).join("");
    if (chunk) chunks.push(chunk);
    if (end >= chars.length) break;
    const nextStart = Math.max(start + 1, end - CHUNK_OVERLAP);
    start = nextStart;
  }
  return chunks;
}

function extractVectors(result, expectedCount) {
  const vectors = Array.isArray(result) ? result : result?.data;
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new KnowledgeError("invalid_ai_response", 502);
  }
  for (const vector of vectors) {
    if (
      !Array.isArray(vector) ||
      vector.length !== VECTOR_DIMENSIONS ||
      vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new KnowledgeError("invalid_ai_response", 502);
    }
  }
  return vectors;
}

async function embedTexts(texts, env) {
  requireAI(env);
  const promise = Promise.resolve().then(() => env.AI.run(MODEL_NAME, { text: texts }));
  const result = await withTimeout(promise, "ai_timeout", timeoutMs(env)).catch((error) => {
    if (error instanceof KnowledgeError) throw error;
    throw new KnowledgeError("ai_upstream_error", 502, error);
  });
  return extractVectors(result, texts.length);
}

async function defaultSupabaseRequest(env, resource, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs(env));
  const headers = new Headers(init.headers || {});
  headers.set("apikey", env.SUPABASE_SERVICE_ROLE_KEY);
  headers.set("authorization", `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
  headers.set("accept", "application/json");
  if (init.body != null) headers.set("content-type", "application/json");
  try {
    const response = await fetch(
      `${String(env.SUPABASE_URL).replace(/\/$/, "")}/rest/v1/${resource}`,
      { ...init, method: init.method || "GET", headers, signal: controller.signal },
    );
    return response;
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw new KnowledgeError("supabase_timeout", 504);
    }
    throw new KnowledgeError("supabase_network_error", 502, error);
  } finally {
    clearTimeout(timer);
  }
}

async function callSupabase(env, resource, init, helpers) {
  requireSupabase(env, helpers);
  let response;
  try {
    const operation = typeof helpers?.supabaseRequest === "function"
      ? helpers.supabaseRequest(env, resource, init)
      : defaultSupabaseRequest(env, resource, init);
    response = await withTimeout(Promise.resolve(operation), "supabase_timeout", timeoutMs(env));
  } catch (error) {
    if (error instanceof KnowledgeError) throw error;
    if (error?.provider === "supabase" && error?.kind === "timeout") {
      throw new KnowledgeError("supabase_timeout", 504, error);
    }
    if (error?.provider === "supabase" && error?.kind === "invalid_response") {
      throw new KnowledgeError("invalid_supabase_response", 502, error);
    }
    if (error?.provider === "supabase" && error?.kind === "upstream_error") {
      throw new KnowledgeError("supabase_upstream_error", 502, error);
    }
    throw new KnowledgeError("supabase_network_error", 502, error);
  }
  if (!(response instanceof Response)) throw new KnowledgeError("invalid_supabase_response", 502);
  if (!response.ok) {
    throw new KnowledgeError("supabase_upstream_error", 502);
  }
  return response;
}

async function responsePayload(response, allowEmpty = false) {
  if (response.status === 204) return allowEmpty ? null : (() => { throw new KnowledgeError("invalid_supabase_response", 502); })();
  const text = await response.text();
  if (!text) {
    if (allowEmpty) return null;
    throw new KnowledgeError("invalid_supabase_response", 502);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new KnowledgeError("invalid_supabase_response", 502);
  }
}

async function insertKnowledge(content, metadata, env, helpers) {
  const chunks = chunkText(content);
  if (!chunks.length) throw new KnowledgeError("content_required", 400);
  const embeddings = [];
  const batchSize = 32;
  for (let index = 0; index < chunks.length; index += batchSize) {
    embeddings.push(...await embedTexts(chunks.slice(index, index + batchSize), env));
  }
  const chunkCount = chunks.length;
  const records = chunks.map((chunk, index) => ({
    content: chunk,
    metadata: {
      ...metadata,
      chunk_index: index,
      chunk_count: chunkCount,
    },
    embedding: embeddings[index],
  }));
  const response = await callSupabase(env, "agent_knowledge", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify(records),
  }, helpers);
  await responsePayload(response, true);
  return { ok: true, count: chunkCount };
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function parseThreshold(value) {
  if (value === null || value === "") return 0.7;
  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new KnowledgeError("invalid_threshold", 400);
  }
  return threshold;
}

function searchOptions(url) {
  const query = (url.searchParams.get("query") || url.searchParams.get("q") || "").trim();
  if (!query) throw new KnowledgeError("query_required", 400);
  if (query.length > MAX_QUERY_LENGTH) throw new KnowledgeError("query_too_long", 413);
  let metadataFilter = {};
  const rawMetadata = url.searchParams.get("metadata");
  if (rawMetadata) {
    try {
      metadataFilter = validateMetadata(JSON.parse(rawMetadata));
    } catch (error) {
      if (error instanceof KnowledgeError) throw error;
      throw new KnowledgeError("invalid_metadata", 400);
    }
  }
  return {
    query,
    limit: boundedInteger(url.searchParams.get("limit"), 10, 1, MAX_SEARCH_RESULTS),
    threshold: parseThreshold(url.searchParams.get("threshold")),
    metadataFilter,
  };
}

function normalizeResults(payload) {
  if (!Array.isArray(payload)) throw new KnowledgeError("invalid_supabase_response", 502);
  const results = [];
  for (const row of payload) {
    if (!row || typeof row !== "object" || typeof row.content !== "string") {
      throw new KnowledgeError("invalid_supabase_response", 502);
    }
    const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? row.metadata
      : {};
    const similarity = Number(row.similarity);
    results.push({
      ...(typeof row.id === "string" ? { id: row.id } : {}),
      content: row.content,
      metadata,
      ...(Number.isFinite(similarity) ? { similarity } : {}),
    });
  }
  return results;
}

async function searchKnowledge(options, env, helpers) {
  const [embedding] = await embedTexts([options.query], env);
  const response = await callSupabase(env, "rpc/match_agent_knowledge", {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({
      query_embedding: embedding,
      match_threshold: options.threshold,
      match_count: options.limit,
      metadata_filter: options.metadataFilter,
    }),
  }, helpers);
  const payload = await responsePayload(response);
  return normalizeResults(payload).slice(0, options.limit);
}

function fitSearchResults(results) {
  const fitted = [];
  let bytes = byteLength("{\"results\":[]}");
  for (const result of results) {
    let candidate = { ...result };
    let candidateBytes = byteLength(JSON.stringify(candidate));
    if (bytes + candidateBytes > MAX_SEARCH_OUTPUT_BYTES) {
      const remaining = MAX_SEARCH_OUTPUT_BYTES - bytes - 64;
      if (remaining <= 0) break;
      const chars = Array.from(candidate.content);
      while (chars.length && byteLength(JSON.stringify({ ...candidate, content: chars.join("") })) > remaining) {
        chars.pop();
      }
      candidate = { ...candidate, content: chars.join("") };
      candidateBytes = byteLength(JSON.stringify(candidate));
      if (!candidate.content || bytes + candidateBytes > MAX_SEARCH_OUTPUT_BYTES) break;
    }
    fitted.push(candidate);
    bytes += candidateBytes + 1;
  }
  return fitted;
}

function sourceLabel(metadata, id = "unknown") {
  for (const key of ["source", "url", "title", "file_name", "filename", "path", "name"]) {
    if (typeof metadata?.[key] === "string" && metadata[key].trim()) return metadata[key].trim();
  }
  return id || "unknown";
}

export async function buildKnowledgeContext(query, env, helpers = {}) {
  if (typeof query !== "string" || !query.trim()) throw new KnowledgeError("query_required", 400);
  const normalizedQuery = query.trim();
  if (normalizedQuery.length > MAX_QUERY_LENGTH) throw new KnowledgeError("query_too_long", 413);
  requireSupabase(env, helpers);
  const results = await searchKnowledge({
    query: normalizedQuery,
    limit: 10,
    threshold: 0.7,
    metadataFilter: {},
  }, env, helpers);
  const sections = [];
  let total = 0;
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const section = `[${index + 1}] 来源: ${sourceLabel(result.metadata, result.id)}\n${result.content}`;
    const separator = sections.length ? "\n\n" : "";
    const remaining = MAX_CONTEXT_CHARS - total - separator.length;
    if (remaining <= 0) break;
    const sectionChars = Array.from(section);
    const fitted = sectionChars.length > remaining ? sectionChars.slice(0, remaining).join("") : section;
    sections.push(separator + fitted);
    total += separator.length + fitted.length;
    if (fitted.length < section.length) break;
  }
  return sections.join("");
}

function routeId(url) {
  if (!url.pathname.startsWith("/knowledge/")) return null;
  const raw = url.pathname.slice("/knowledge/".length);
  if (!raw || raw.includes("/")) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

async function handleCreate(request, env, helpers) {
  const body = await parseJsonBody(request);
  requireAI(env);
  requireSupabase(env, helpers);
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  if (!content) throw new KnowledgeError("content_required", 400);
  if (byteLength(content) > MAX_BODY_BYTES) throw new KnowledgeError("content_too_large", 413);
  const metadata = validateMetadata(body?.metadata);
  return insertKnowledge(content, metadata, env, helpers);
}

async function handleSearch(url, env, helpers) {
  requireAI(env);
  requireSupabase(env, helpers);
  const options = searchOptions(url);
  const results = await searchKnowledge(options, env, helpers);
  return { query: options.query, results: fitSearchResults(results) };
}

async function handleDelete(id, env, helpers) {
  requireSupabase(env, helpers);
  if (!UUID_PATTERN.test(id)) throw new KnowledgeError("invalid_knowledge_id", 400);
  const response = await callSupabase(env, `agent_knowledge?id=eq.${id}`, {
    method: "DELETE",
    headers: { prefer: "return=representation" },
  }, helpers);
  const payload = await responsePayload(response);
  if (!Array.isArray(payload)) throw new KnowledgeError("invalid_supabase_response", 502);
  if (!payload.length) throw new KnowledgeError("knowledge_not_found", 404);
  return { ok: true, id };
}

function errorResponse(error) {
  if (error instanceof KnowledgeError) return json({ error: error.code }, error.status);
  return json({ error: "internal_error" }, 500);
}

export async function handleKnowledgeRequest(request, env, url = new URL(request.url), helpers = {}) {
  try {
    if (url.pathname === "/knowledge" && request.method === "POST") {
      return json(await handleCreate(request, env, helpers), 201);
    }
    if (url.pathname === "/knowledge/search" && request.method === "GET") {
      return json(await handleSearch(url, env, helpers));
    }
    const id = routeId(url);
    if (id !== null && request.method === "DELETE") {
      return json(await handleDelete(id, env, helpers));
    }
    return json({ error: "method_not_allowed" }, 405, { allow: "GET, POST, DELETE" });
  } catch (error) {
    return errorResponse(error);
  }
}

export {
  CHUNK_OVERLAP,
  MAX_CONTEXT_CHARS,
  MODEL_NAME,
  TARGET_CHUNK_LENGTH,
  VECTOR_DIMENSIONS,
};
