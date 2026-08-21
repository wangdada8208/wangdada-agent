import { handleKnowledgeRequest } from "./knowledge.js";

const SERVICE_NAME = "wangdada-agent-api";
const MAX_JSON_BYTES = 128 * 1024;
const MAX_MESSAGE_LENGTH = 32_768;
const MAX_MEMORY_LENGTH = 32_768;
const MAX_TASK_TITLE_LENGTH = 200;
const MAX_TASK_DESCRIPTION_LENGTH = 10_000;
const MAX_CACHE_VALUE_BYTES = 64 * 1024;
const DEFAULT_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const TASK_STATUSES = new Set(["pending", "running", "completed", "failed", "cancelled"]);
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const TOKEN_PATTERN = /^[^\u0000-\u001f\u007f]{1,256}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_PATTERN = /^[A-Za-z0-9+/_=-]{1,2048}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_RELEASE_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

class ProviderError extends Error {
  constructor(provider, kind, status = null) {
    super(`${provider}_${kind}`);
    this.provider = provider;
    this.kind = kind;
    this.status = status;
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

function allowedOrigin(request, env) {
  const configured = typeof env.FRONTEND_ORIGIN === "string" ? env.FRONTEND_ORIGIN.trim() : "";
  const origin = request.headers.get("origin") || "";
  return configured && origin === configured ? configured : "";
}

function withCors(response, request, env) {
  const origin = allowedOrigin(request, env);
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-headers", "content-type, authorization");
  headers.set("access-control-allow-methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

function withRequestId(response, requestId) {
  if (response.status < 400) return response;
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  return new Response(response.body, { status: response.status, headers });
}

function traceRequestId(request) {
  const supplied = request.headers.get("x-request-id") || "";
  return UUID_PATTERN.test(supplied) ? supplied : crypto.randomUUID();
}

function errorKind(error) {
  if (error instanceof ProviderError) return `${error.provider}_${error.kind}`;
  return "internal_error";
}

function authorized(request, env) {
  const expected = typeof env.INTERNAL_API_TOKEN === "string" ? env.INTERNAL_API_TOKEN : "";
  return Boolean(expected) && request.headers.get("authorization") === `Bearer ${expected}`;
}

function hasSupabase(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

function hasUpstash(env) {
  return Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);
}

function hasModel(env) {
  return Boolean(env.MODEL_API_URL && env.MODEL_API_KEY);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function timeoutFor(env, name = "SERVICE_TIMEOUT_MS") {
  return boundedInteger(env[name], DEFAULT_TIMEOUT_MS, 1, 120_000);
}

async function fetchProvider(provider, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw new ProviderError(provider, "timeout");
    }
    throw new ProviderError(provider, "network_error");
  } finally {
    clearTimeout(timer);
  }
}

function providerErrorResponse(error) {
  if (!(error instanceof ProviderError)) return json({ error: "internal_error" }, 500);
  if (error.kind === "timeout") return json({ error: `${error.provider}_timeout` }, 504);
  if (error.kind === "invalid_response") return json({ error: "invalid_upstream_response" }, 502);
  if (error.kind === "upstream_error") {
    return json({ error: `${error.provider}_upstream_error`, upstream_status: error.status }, 502);
  }
  return json({ error: `${error.provider}_network_error` }, 502);
}

async function parseJsonBody(request, maximumBytes = MAX_JSON_BYTES) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await request.body?.cancel("request_too_large");
    return { error: json({ error: "request_too_large" }, 413) };
  }
  const body = await readBoundedBody(request.body, maximumBytes);
  if (body.tooLarge) {
    return { error: json({ error: "request_too_large" }, 413) };
  }
  const text = new TextDecoder().decode(body.bytes);
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: json({ error: "invalid_json" }, 400) };
  }
}

async function readBoundedBody(stream, maximumBytes) {
  if (!stream) return { bytes: new Uint8Array(0), tooLarge: false };
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("body_too_large");
        return { bytes: null, tooLarge: true };
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, tooLarge: false };
}

function validateSessionId(value, required = false) {
  const sessionId = typeof value === "string" ? value.trim() : "";
  if (!sessionId && !required) return { value: "default" };
  if (!SESSION_ID_PATTERN.test(sessionId)) return { error: json({ error: "invalid_session_id" }, 400) };
  return { value: sessionId };
}

function validateKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!KEY_PATTERN.test(key) || key.split("/").some((part) => part === "..")) {
    return { error: json({ error: "invalid_key" }, 400) };
  }
  return { value: key };
}

function validateFileKey(pathname) {
  let key;
  try {
    key = decodeURIComponent(pathname.slice("/files/".length));
  } catch {
    return { error: json({ error: "invalid_file_key" }, 400) };
  }
  if (
    !key ||
    key.length > 512 ||
    key.startsWith("/") ||
    key.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(key) ||
    key.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return { error: json({ error: "invalid_file_key" }, 400) };
  }
  return { value: key };
}

function validateCursor(value) {
  if (value === null) return { value: null };
  if (!CURSOR_PATTERN.test(value)) {
    return { error: json({ error: "invalid_cursor" }, 400) };
  }
  return { value };
}

async function supabaseRequest(env, resource, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("apikey", env.SUPABASE_SERVICE_ROLE_KEY);
  headers.set("authorization", `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
  headers.set("accept", "application/json");
  if (init.body != null) headers.set("content-type", "application/json");
  const response = await fetchProvider(
    "supabase",
    `${String(env.SUPABASE_URL).replace(/\/$/, "")}/rest/v1/${resource}`,
    { ...init, method: init.method || "GET", headers },
    timeoutFor(env),
  );
  if (!response.ok) throw new ProviderError("supabase", "upstream_error", response.status);
  return response;
}

async function responsePayload(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function supabasePayload(response, { allowEmpty = false, requireArray = false } = {}) {
  const text = await response.text();
  if (!text) {
    if (allowEmpty) return null;
    throw new ProviderError("supabase", "invalid_response");
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ProviderError("supabase", "invalid_response");
  }
  if (requireArray && !Array.isArray(payload)) {
    throw new ProviderError("supabase", "invalid_response");
  }
  return payload;
}

async function redisCommand(env, command) {
  const response = await fetchProvider("upstash", env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
  }, timeoutFor(env));
  if (!response.ok) throw new ProviderError("upstash", "upstream_error", response.status);
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ProviderError("upstash", "invalid_response");
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !Object.hasOwn(payload, "result")
  ) {
    throw new ProviderError("upstash", "invalid_response");
  }
  return payload.result;
}

function requireSupabase(env) {
  return hasSupabase(env) ? null : json({ error: "supabase_not_configured" }, 503);
}

function requireUpstash(env) {
  return hasUpstash(env) ? null : json({ error: "upstash_not_configured" }, 503);
}

function requireR2(env) {
  return env.FILES ? null : json({ error: "r2_not_configured" }, 503);
}

async function getMemory(env, sessionId, limit = 100) {
  const query = new URLSearchParams({
    session_id: `eq.${sessionId}`,
    select: "id,session_id,turn_id,role,content,created_at",
    order: "created_at.desc",
    limit: String(limit),
  });
  const response = await supabaseRequest(env, `agent_messages?${query}`);
  return supabasePayload(response, { requireArray: true });
}

async function getTurnMessages(env, turnId) {
  const query = new URLSearchParams({
    turn_id: `eq.${turnId}`,
    select: "turn_id,role,content,created_at",
    order: "created_at.asc",
  });
  const response = await supabaseRequest(env, `agent_messages?${query}`);
  return supabasePayload(response, { requireArray: true });
}

function storedChatResponse(message, requestId) {
  return json({
    choices: [{ message: { role: "assistant", content: message.content } }],
    request_id: requestId,
    cached: true,
  });
}

async function acquireSessionLock(env, sessionId, token) {
  const ttl = boundedInteger(env.CHAT_LOCK_TTL_SECONDS, 120, 5, 600);
  return await redisCommand(env, ["SET", `lock:session:${sessionId}`, token, "NX", "EX", ttl]) === "OK";
}

async function releaseSessionLock(env, sessionId, token) {
  await redisCommand(env, ["EVAL", SAFE_RELEASE_SCRIPT, 1, `lock:session:${sessionId}`, token]);
}

async function insertMessage(env, record, representation = false) {
  const response = await supabaseRequest(env, "agent_messages", {
    method: "POST",
    headers: { prefer: representation ? "return=representation" : "return=minimal" },
    body: JSON.stringify(record),
  });
  return {
    response,
    payload: await supabasePayload(response, {
      allowEmpty: !representation,
      requireArray: representation,
    }),
  };
}

async function handleMemory(request, env, url) {
  const missing = requireSupabase(env);
  if (missing) return missing;

  if (request.method === "GET") {
    const session = validateSessionId(url.searchParams.get("session_id"));
    if (session.error) return session.error;
    const rows = await getMemory(env, session.value, boundedInteger(url.searchParams.get("limit"), 100, 1, 100));
    return json(rows.reverse());
  }

  if (request.method === "POST") {
    const body = await parseJsonBody(request);
    if (body.error) return body.error;
    const session = validateSessionId(body.value?.session_id);
    if (session.error) return session.error;
    const role = body.value?.role;
    if (role !== "user" && role !== "assistant" && role !== "system") {
      return json({ error: "invalid_role" }, 400);
    }
    const content = typeof body.value?.content === "string" ? body.value.content.trim() : "";
    if (!content) return json({ error: "content_required" }, 400);
    if (content.length > MAX_MEMORY_LENGTH) return json({ error: "content_too_long" }, 413);
    const inserted = await insertMessage(env, { session_id: session.value, role, content }, true);
    return json(inserted.payload, inserted.response.status);
  }

  if (request.method === "DELETE") {
    const session = validateSessionId(url.searchParams.get("session_id"), true);
    if (session.error) return session.error;
    const query = new URLSearchParams({ session_id: `eq.${session.value}` });
    await supabaseRequest(env, `agent_messages?${query}`, {
      method: "DELETE",
      headers: { prefer: "return=minimal" },
    });
    return json({ ok: true, session_id: session.value });
  }

  return json({ error: "method_not_allowed" }, 405, { allow: "GET, POST, DELETE" });
}

function taskRecord(body, partial = false) {
  const result = {};
  if (!partial || Object.hasOwn(body, "title")) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return { error: json({ error: "title_required" }, 400) };
    if (title.length > MAX_TASK_TITLE_LENGTH) return { error: json({ error: "title_too_long" }, 413) };
    result.title = title;
  }
  if (Object.hasOwn(body, "description")) {
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (description.length > MAX_TASK_DESCRIPTION_LENGTH) {
      return { error: json({ error: "description_too_long" }, 413) };
    }
    result.description = description;
  } else if (!partial) {
    result.description = "";
  }
  if (Object.hasOwn(body, "status") || !partial) {
    const status = body.status || "pending";
    if (!TASK_STATUSES.has(status)) return { error: json({ error: "invalid_task_status" }, 400) };
    result.status = status;
  }
  for (const field of ["payload", "result"]) {
    if (Object.hasOwn(body, field)) result[field] = body[field] ?? {};
  }
  if (Object.hasOwn(body, "due_at")) result.due_at = body.due_at || null;
  return { value: result };
}

async function getTaskById(env, id) {
  const query = new URLSearchParams({
    id: `eq.${id}`,
    select: "id,title,description,status,payload,result,due_at,idempotency_key,version,created_at,updated_at",
    limit: "1",
  });
  const response = await supabaseRequest(env, `agent_tasks?${query}`);
  const rows = await supabasePayload(response, { requireArray: true });
  return rows[0] || null;
}

async function getTaskByIdempotencyKey(env, key) {
  const query = new URLSearchParams({
    idempotency_key: `eq.${key}`,
    select: "id,title,description,status,payload,result,due_at,idempotency_key,version,created_at,updated_at",
    limit: "1",
  });
  const response = await supabaseRequest(env, `agent_tasks?${query}`);
  return supabasePayload(response, { requireArray: true });
}

async function handleTaskClaim(request, env) {
  const missing = requireSupabase(env);
  if (missing) return missing;
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
  const body = await parseJsonBody(request);
  if (body.error) return body.error;
  const response = await supabaseRequest(env, "rpc/claim_agent_task", {
    method: "POST",
    body: JSON.stringify({}),
  });
  const tasks = await supabasePayload(response, { requireArray: true });
  return json({ task: tasks[0] || null });
}

async function handleTasks(request, env, url) {
  const missing = requireSupabase(env);
  if (missing) return missing;

  if (request.method === "GET") {
    const status = url.searchParams.get("status");
    if (status && !TASK_STATUSES.has(status)) return json({ error: "invalid_task_status" }, 400);
    const query = new URLSearchParams({
      select: "id,title,description,status,payload,result,due_at,idempotency_key,version,created_at,updated_at",
      order: "created_at.desc",
      limit: String(boundedInteger(url.searchParams.get("limit"), 100, 1, 100)),
    });
    if (status) query.set("status", `eq.${status}`);
    const response = await supabaseRequest(env, `agent_tasks?${query}`);
    return json(await supabasePayload(response, { requireArray: true }));
  }

  if (request.method === "POST") {
    const body = await parseJsonBody(request);
    if (body.error) return body.error;
    const idempotencyKey = body.value?.idempotency_key == null
      ? null
      : String(body.value.idempotency_key).trim();
    if (idempotencyKey !== null && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return json({ error: "invalid_idempotency_key" }, 400);
    }
    if (idempotencyKey) {
      const existing = await getTaskByIdempotencyKey(env, idempotencyKey);
      if (existing.length) return json(existing);
    }
    const record = taskRecord(body.value || {});
    if (record.error) return record.error;
    if (idempotencyKey) record.value.idempotency_key = idempotencyKey;
    try {
      const response = await supabaseRequest(env, "agent_tasks", {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: JSON.stringify(record.value),
      });
      return json(await supabasePayload(response, { requireArray: true }), response.status);
    } catch (error) {
      if (idempotencyKey && error instanceof ProviderError && error.status === 409) {
        const existing = await getTaskByIdempotencyKey(env, idempotencyKey);
        if (existing.length) return json(existing);
      }
      throw error;
    }
  }

  if (request.method === "PATCH") {
    const body = await parseJsonBody(request);
    if (body.error) return body.error;
    const id = typeof body.value?.id === "string" ? body.value.id.trim() : "";
    if (!UUID_PATTERN.test(id)) return json({ error: "invalid_task_id" }, 400);
    let expectedVersion = Number(body.value?.version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) expectedVersion = null;
    let expectedStatus = body.value?.expected_status;
    if (expectedStatus != null && !TASK_STATUSES.has(expectedStatus)) {
      return json({ error: "invalid_expected_status" }, 400);
    }
    if (expectedVersion === null || expectedStatus == null) {
      const current = await getTaskById(env, id);
      if (!current) return json({ error: "task_not_found" }, 404);
      if (expectedVersion === null) expectedVersion = Number.isInteger(current.version) ? current.version : 1;
      if (expectedStatus == null) expectedStatus = current.status;
    }
    const record = taskRecord(body.value || {}, true);
    if (record.error) return record.error;
    if (!Object.keys(record.value).length) return json({ error: "no_task_updates" }, 400);
    record.value.version = expectedVersion + 1;
    const query = new URLSearchParams({
      id: `eq.${id}`,
      version: `eq.${expectedVersion}`,
      status: `eq.${expectedStatus}`,
    });
    const response = await supabaseRequest(env, `agent_tasks?${query}`, {
      method: "PATCH",
      headers: { prefer: "return=representation" },
      body: JSON.stringify(record.value),
    });
    const updated = await supabasePayload(response, { requireArray: true });
    if (updated.length === 0) {
      return await getTaskById(env, id)
        ? json({ error: "task_conflict" }, 409)
        : json({ error: "task_not_found" }, 404);
    }
    return json(updated);
  }

  return json({ error: "method_not_allowed" }, 405, { allow: "GET, POST, PATCH" });
}

async function handleCache(request, env, url) {
  const missing = requireUpstash(env);
  if (missing) return missing;

  if (request.method === "GET" || request.method === "DELETE") {
    const key = validateKey(url.searchParams.get("key"));
    if (key.error) return key.error;
    const redisKey = `cache:${key.value}`;
    if (request.method === "GET") {
      return json({ key: key.value, value: await redisCommand(env, ["GET", redisKey]) ?? null });
    }
    const deleted = await redisCommand(env, ["DEL", redisKey]);
    return json({ ok: true, key: key.value, deleted: Number(deleted) > 0 });
  }

  if (request.method === "PUT") {
    const body = await parseJsonBody(request);
    if (body.error) return body.error;
    const key = validateKey(body.value?.key);
    if (key.error) return key.error;
    const value = typeof body.value?.value === "string"
      ? body.value.value
      : JSON.stringify(body.value?.value ?? null);
    if (new TextEncoder().encode(value).byteLength > MAX_CACHE_VALUE_BYTES) {
      return json({ error: "cache_value_too_large" }, 413);
    }
    const ttl = boundedInteger(body.value?.ttl, 3_600, 30, 86_400);
    await redisCommand(env, ["SET", `cache:${key.value}`, value, "EX", ttl]);
    return json({ ok: true, key: key.value, ttl });
  }

  return json({ error: "method_not_allowed" }, 405, { allow: "GET, PUT, DELETE" });
}

async function handleLock(request, env, pathname) {
  const missing = requireUpstash(env);
  if (missing) return missing;
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
  const body = await parseJsonBody(request);
  if (body.error) return body.error;
  const key = validateKey(body.value?.key);
  if (key.error) return key.error;
  const token = typeof body.value?.token === "string" ? body.value.token : "";
  if (!TOKEN_PATTERN.test(token)) return json({ error: "invalid_lock_token" }, 400);
  const redisKey = `lock:${key.value}`;

  if (pathname === "/locks/acquire") {
    const ttl = boundedInteger(body.value?.ttl, 60, 5, 3_600);
    const acquired = await redisCommand(env, ["SET", redisKey, token, "NX", "EX", ttl]);
    return json({ acquired: acquired === "OK", key: key.value });
  }

  const released = await redisCommand(env, ["EVAL", SAFE_RELEASE_SCRIPT, 1, redisKey, token]);
  return json({ released: Number(released) === 1, key: key.value });
}

async function handleFiles(request, env, url) {
  const missing = requireR2(env);
  if (missing) return missing;

  if (url.pathname === "/files") {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
    const cursor = validateCursor(url.searchParams.get("cursor"));
    if (cursor.error) return cursor.error;
    const listOptions = { limit: 100 };
    if (cursor.value) listOptions.cursor = cursor.value;
    const listed = await env.FILES.list(listOptions);
    return json({
      objects: (listed.objects || []).map((object) => ({
        key: object.key,
        size: object.size,
        uploaded: object.uploaded,
      })),
      truncated: Boolean(listed.truncated),
      cursor: listed.truncated ? listed.cursor : undefined,
    });
  }

  const key = validateFileKey(url.pathname);
  if (key.error) return key.error;

  if (request.method === "PUT") {
    const maximum = boundedInteger(env.MAX_FILE_BYTES, DEFAULT_FILE_BYTES, 1, 25 * 1024 * 1024);
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maximum) {
      await request.body?.cancel("file_too_large");
      return json({ error: "file_too_large" }, 413);
    }
    const body = await readBoundedBody(request.body, maximum);
    if (body.tooLarge) return json({ error: "file_too_large" }, 413);
    await env.FILES.put(key.value, body.bytes, {
      httpMetadata: { contentType: request.headers.get("content-type") || "application/octet-stream" },
    });
    return json({ ok: true, key: key.value, size: body.bytes.byteLength });
  }

  if (request.method === "DELETE") {
    await env.FILES.delete(key.value);
    return json({ ok: true, key: key.value });
  }

  if (request.method === "GET") {
    const object = await env.FILES.get(key.value);
    if (!object) return json({ error: "not_found" }, 404);
    const headers = new Headers({ "cache-control": "no-store" });
    object.writeHttpMetadata(headers);
    if (object.httpEtag) headers.set("etag", object.httpEtag);
    return new Response(object.body, { headers });
  }

  return json({ error: "method_not_allowed" }, 405, { allow: "GET, PUT, DELETE" });
}


function extractResponsesAnswer(payload) {
  if (!Array.isArray(payload?.output)) return undefined;
  for (const item of payload.output) {
    if (item?.type !== "message" || item?.role !== "assistant") continue;
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (part?.type === "output_text" && typeof part?.text === "string") return part.text;
    }
  }
  return undefined;
}

function setResponsesAnswer(payload, text) {
  if (!Array.isArray(payload?.output)) return;
  for (const item of payload.output) {
    if (item?.type !== "message" || item?.role !== "assistant") continue;
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (part?.type === "output_text" && typeof part?.text === "string") { part.text = text; return; }
    }
  }
}

async function handleChat(request, env, traceId) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
  const databaseMissing = requireSupabase(env);
  if (databaseMissing) return databaseMissing;

  const body = await parseJsonBody(request);
  if (body.error) return body.error;
  const session = validateSessionId(body.value?.session_id);
  if (session.error) return session.error;
  const message = typeof body.value?.message === "string" ? body.value.message.trim() : "";
  if (!message) return json({ error: "message_required" }, 400);
  if (message.length > MAX_MESSAGE_LENGTH) return json({ error: "message_too_long" }, 413);
  const requestId = body.value?.request_id == null ? null : String(body.value.request_id).trim();
  if (requestId !== null && !UUID_PATTERN.test(requestId)) {
    return json({ error: "invalid_request_id" }, 400);
  }

  if (requestId) {
    const existing = await getTurnMessages(env, requestId);
    const assistant = existing.find((item) => item.role === "assistant" && typeof item.content === "string");
    if (assistant) return storedChatResponse(assistant, requestId);
  }

  if (!hasModel(env)) return json({ error: "model_not_configured" }, 503);
  const cacheMissing = requireUpstash(env);
  if (cacheMissing) return cacheMissing;

  const lockToken = crypto.randomUUID();
  if (!await acquireSessionLock(env, session.value, lockToken)) {
    return json({ error: "session_busy" }, 409);
  }

  try {
    let existingTurn = [];
    if (requestId) {
      existingTurn = await getTurnMessages(env, requestId);
      const assistant = existingTurn.find((item) => item.role === "assistant" && typeof item.content === "string");
      if (assistant) return storedChatResponse(assistant, requestId);
      const existingUser = existingTurn.find((item) => item.role === "user");
      if (existingUser && existingUser.content !== message) {
        return json({ error: "request_id_conflict" }, 409);
      }
    }

    const recent = await getMemory(env, session.value, 20);
    const messages = recent.reverse()
      .filter((item) => item.turn_id !== requestId)
      .filter((item) => (item.role === "user" || item.role === "assistant" || item.role === "system") && typeof item.content === "string")
      .map((item) => ({ role: item.role, content: item.content }));
    if (typeof env.SYSTEM_PROMPT === "string" && env.SYSTEM_PROMPT.trim()) {
      messages.unshift({ role: "system", content: env.SYSTEM_PROMPT.trim().slice(0, MAX_MESSAGE_LENGTH) });
    }
    messages.push({ role: "user", content: message });

    const existingUser = existingTurn.find((item) => item.role === "user");
    if (!existingUser) {
      const userRecord = { session_id: session.value, role: "user", content: message };
      if (requestId) userRecord.turn_id = requestId;
      await insertMessage(env, userRecord);
    }
    const isResponsesApi = env.MODEL_API_URL.includes("/responses");
    const requestBody = isResponsesApi
      ? { model: env.MODEL_NAME || "gpt-4o-mini", input: messages }
      : { model: env.MODEL_NAME || "gpt-4o-mini", messages };
    const upstream = await fetchProvider("model", env.MODEL_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.MODEL_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    }, timeoutFor(env, "UPSTREAM_TIMEOUT_MS"));
    if (!upstream.ok) throw new ProviderError("model", "upstream_error", upstream.status);
    const payload = await responsePayload(upstream);
    const answer = isResponsesApi
      ? extractResponsesAnswer(payload)
      : payload?.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim()) {
      return json({ error: "model_invalid_response" }, 502);
    }
    const boundedAnswer = answer.trim().slice(0, MAX_MEMORY_LENGTH);
    if (isResponsesApi) {
      setResponsesAnswer(payload, boundedAnswer);
    } else {
      payload.choices[0].message.content = boundedAnswer;
    }
    if (requestId) {
      payload.request_id = requestId;
      payload.cached = false;
    }
    const assistantRecord = { session_id: session.value, role: "assistant", content: boundedAnswer };
    if (requestId) assistantRecord.turn_id = requestId;
    await insertMessage(env, assistantRecord);
    return json(payload);
  } finally {
    try {
      await releaseSessionLock(env, session.value, lockToken);
    } catch (error) {
      console.error("worker_request_error", {
        request_id: traceId,
        path: "/chat",
        error_kind: `session_lock_release_${errorKind(error)}`,
      });
    }
  }
}

function isPrivatePath(pathname) {
  return pathname === "/chat" ||
    pathname === "/memory" ||
    pathname === "/tasks" ||
    pathname === "/tasks/claim" ||
    pathname === "/cache" ||
    pathname === "/locks/acquire" ||
    pathname === "/locks/release" ||
    pathname === "/files" ||
    pathname.startsWith("/files/") ||
    pathname.startsWith("/knowledge");
}

async function route(request, env, traceId) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    if (!allowedOrigin(request, env)) return json({ error: "cors_origin_denied" }, 403);
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": allowedOrigin(request, env),
        "access-control-allow-headers": "content-type, authorization",
        "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
        "access-control-max-age": "86400",
        vary: "Origin",
      },
    });
  }

  if (url.pathname === "/" && request.method === "GET") {
    return json({
      name: SERVICE_NAME,
      status: "ok",
      endpoints: ["GET /health", "POST /chat", "/memory", "/tasks", "/cache", "/locks/*", "/files", "/knowledge"],
    });
  }

  if (url.pathname === "/health" && request.method === "GET") {
    const integrations = {
      r2: Boolean(env.FILES),
      supabase: hasSupabase(env),
      upstash: hasUpstash(env),
      model: hasModel(env),
      ai: Boolean(env.AI),
    };
    return json({ ok: Object.values(integrations).every(Boolean), service: SERVICE_NAME, integrations });
  }

  if (isPrivatePath(url.pathname) && !authorized(request, env)) return json({ error: "unauthorized" }, 401);

  if (url.pathname === "/chat") return handleChat(request, env, traceId);
  if (url.pathname === "/memory") return handleMemory(request, env, url);
  if (url.pathname === "/tasks/claim") return handleTaskClaim(request, env);
  if (url.pathname === "/tasks") return handleTasks(request, env, url);
  if (url.pathname === "/cache") return handleCache(request, env, url);
  if (url.pathname === "/locks/acquire" || url.pathname === "/locks/release") {
    return handleLock(request, env, url.pathname);
  }
  if (url.pathname === "/files" || url.pathname.startsWith("/files/")) {
    return handleFiles(request, env, url);
  }
  if (url.pathname === "/knowledge" || url.pathname.startsWith("/knowledge/")) {
    return handleKnowledgeRequest(request, env, url);
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    const requestId = traceRequestId(request);
    let response;
    try {
      response = await route(request, env, requestId);
    } catch (error) {
      console.error("worker_request_error", {
        request_id: requestId,
        path: new URL(request.url).pathname,
        error_kind: errorKind(error),
      });
      response = providerErrorResponse(error);
    }
    return withCors(withRequestId(response, requestId), request, env);
  },
};
