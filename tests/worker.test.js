import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import worker from "../src/index.js";

const TOKEN = "internal-secret";
const API = "https://agent.example.test";
const REAL_CONSOLE_ERROR = console.error;

test.beforeEach(() => { console.error = () => {}; });
test.afterEach(() => { console.error = REAL_CONSOLE_ERROR; });

function request(path, init = {}, authorized = true) {
  const headers = new Headers(init.headers || {});
  if (authorized) headers.set("authorization", `Bearer ${TOKEN}`);
  return new Request(`${API}${path}`, { ...init, headers });
}

function jsonRequest(path, method, body, authorized = true, headers = {}) {
  return request(path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }, authorized);
}

function baseEnv(overrides = {}) {
  return {
    INTERNAL_API_TOKEN: TOKEN,
    FRONTEND_ORIGIN: "https://app.example.test",
    SUPABASE_URL: "https://db.example.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    UPSTASH_REDIS_REST_URL: "https://redis.example.test",
    UPSTASH_REDIS_REST_TOKEN: "redis-token",
    MODEL_API_URL: "https://model.example.test/v1/chat/completions",
    MODEL_API_KEY: "model-token",
    MODEL_NAME: "test-model",
    FILES: createR2(),
    ...overrides,
  };
}

function createR2() {
  const objects = new Map();
  return {
    objects,
    async list() {
      return {
        objects: [...objects.entries()].map(([key, object]) => ({
          key,
          size: object.bytes.byteLength,
          uploaded: object.uploaded,
        })),
        truncated: false,
      };
    },
    async put(key, value, options = {}) {
      const bytes = new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, {
        bytes,
        contentType: options.httpMetadata?.contentType || "application/octet-stream",
        uploaded: new Date("2026-08-17T00:00:00Z"),
      });
    },
    async get(key) {
      const value = objects.get(key);
      if (!value) return null;
      return {
        body: value.bytes,
        httpEtag: `etag-${key}`,
        writeHttpMetadata(headers) {
          headers.set("content-type", value.contentType);
        },
      };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

async function responseJson(response) {
  return JSON.parse(await response.text());
}

test("private endpoints require the configured bearer token", async () => {
  const env = baseEnv();
  const privateRequests = [
    request("/chat", { method: "POST" }, false),
    request("/memory", {}, false),
    request("/tasks", {}, false),
    request("/cache?key=x", {}, false),
    request("/locks/acquire", { method: "POST" }, false),
    request("/files", {}, false),
  ];

  for (const privateRequest of privateRequests) {
    const response = await worker.fetch(privateRequest, env);
    assert.equal(response.status, 401);
    assert.deepEqual(await responseJson(response), { error: "unauthorized" });
  }
});

test("CORS is emitted only for the configured frontend origin", async () => {
  const env = baseEnv();
  const allowed = await worker.fetch(request("/health", {
    headers: { origin: "https://app.example.test" },
  }, false), env);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.example.test");
  assert.equal(allowed.headers.get("vary"), "Origin");

  const denied = await worker.fetch(request("/health", {
    headers: { origin: "https://evil.example.test" },
  }, false), env);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);

  const preflight = await worker.fetch(request("/chat", {
    method: "OPTIONS",
    headers: { origin: "https://evil.example.test" },
  }, false), env);
  assert.equal(preflight.status, 403);

  const disabled = await worker.fetch(request("/health", {
    headers: { origin: "https://app.example.test" },
  }, false), baseEnv({ FRONTEND_ORIGIN: "" }));
  assert.equal(disabled.headers.get("access-control-allow-origin"), null);
});

test("health accurately reports every integration", async () => {
  const response = await worker.fetch(request("/health", {}, false), baseEnv({
    FILES: undefined,
    UPSTASH_REDIS_REST_TOKEN: "",
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await responseJson(response), {
    ok: false,
    service: "wangdada-agent-api",
    integrations: {
      r2: false,
      supabase: true,
      upstash: false,
      model: true,
      ai: false,
    },
  });
});

test("chat loads recent memory, sends it to the model, and persists both messages", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://redis.example.test")) {
      const command = JSON.parse(init.body);
      return Response.json({ result: command[0] === "SET" ? "OK" : 1 });
    }
    if (String(url).includes("agent_messages?") && init.method === "GET") {
      return Response.json([
        { role: "assistant", content: "old answer", created_at: "2026-08-17T00:02:00Z" },
        { role: "user", content: "old question", created_at: "2026-08-17T00:01:00Z" },
      ]);
    }
    if (String(url).endsWith("/agent_messages") && init.method === "POST") {
      return new Response(null, { status: 201 });
    }
    if (String(url).startsWith("https://model.example.test")) {
      return Response.json({ choices: [{ message: { role: "assistant", content: "new answer" } }] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const response = await worker.fetch(jsonRequest("/chat", "POST", {
    session_id: "session-123",
    message: "new question",
  }), baseEnv());

  assert.equal(response.status, 200);
  const historyCall = calls.find((call) => call.url.includes("agent_messages?"));
  assert.match(historyCall.url, /session_id=eq\.session-123/);
  assert.match(historyCall.url, /order=created_at\.desc/);

  const modelCall = calls.find((call) => call.url.startsWith("https://model.example.test"));
  const modelBody = JSON.parse(modelCall.init.body);
  assert.deepEqual(modelBody.messages, [
    { role: "user", content: "old question" },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "new question" },
  ]);

  const inserts = calls
    .filter((call) => call.url.endsWith("/agent_messages") && call.init.method === "POST")
    .map((call) => JSON.parse(call.init.body));
  assert.deepEqual(inserts, [
    { session_id: "session-123", role: "user", content: "new question" },
    { session_id: "session-123", role: "assistant", content: "new answer" },
  ]);
});

test("chat request_id returns an already persisted assistant result without calling the model", async (t) => {
  const requestId = "f3f6aa47-1487-4d40-98e9-a8ab2a7c556d";
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("turn_id=eq.")) {
      return Response.json([{
        turn_id: requestId,
        role: "assistant",
        content: "stored answer",
      }]);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const response = await worker.fetch(jsonRequest("/chat", "POST", {
    session_id: "session-idempotent",
    request_id: requestId,
    message: "same request",
  }), baseEnv({
    MODEL_API_URL: "",
    MODEL_API_KEY: "",
    UPSTASH_REDIS_REST_URL: "",
    UPSTASH_REDIS_REST_TOKEN: "",
  }));
  assert.equal(response.status, 200);
  const payload = await responseJson(response);
  assert.equal(payload.choices[0].message.content, "stored answer");
  assert.equal(payload.request_id, requestId);
  assert.equal(payload.cached, true);
  assert.equal(calls.some((call) => call.url.startsWith("https://model.example.test")), false);
  assert.equal(calls.some((call) => call.url.startsWith("https://redis.example.test")), false);
});

test("chat returns session_busy when the Upstash session lock is already held", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://redis.example.test")) return Response.json({ result: null });
    throw new Error(`unexpected fetch: ${url}`);
  };

  const response = await worker.fetch(jsonRequest("/chat", "POST", {
    session_id: "busy-session",
    message: "hello",
  }), baseEnv());
  assert.equal(response.status, 409);
  assert.deepEqual(await responseJson(response), { error: "session_busy" });
  const commands = calls.map((call) => JSON.parse(call.init.body));
  assert.deepEqual(commands, [["SET", "lock:session:busy-session", commands[0][2], "NX", "EX", 120]]);
  assert.equal(calls.some((call) => call.url.startsWith("https://model.example.test")), false);
});

test("chat safely releases its session lock even when the model fails", async (t) => {
  const redisCommands = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith("https://redis.example.test")) {
      const command = JSON.parse(init.body);
      redisCommands.push(command);
      return Response.json({ result: command[0] === "SET" ? "OK" : 1 });
    }
    if (String(url).includes("agent_messages?") && init.method === "GET") return Response.json([]);
    if (String(url).endsWith("/agent_messages") && init.method === "POST") return new Response(null, { status: 201 });
    if (String(url).startsWith("https://model.example.test")) return new Response("failure", { status: 503 });
    throw new Error(`unexpected fetch: ${url}`);
  };

  const response = await worker.fetch(jsonRequest("/chat", "POST", {
    session_id: "release-session",
    message: "hello",
  }), baseEnv());
  assert.equal(response.status, 502);
  assert.equal(redisCommands[0][0], "SET");
  assert.equal(redisCommands[1][0], "EVAL");
  assert.equal(redisCommands[1].at(-2), "lock:session:release-session");
  assert.equal(redisCommands[1].at(-1), redisCommands[0][2]);
});

test("chat rejects invalid JSON, unsafe sessions, oversized input, upstream failures, and timeouts", async (t) => {
  const invalid = await worker.fetch(request("/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  }), baseEnv());
  assert.equal(invalid.status, 400);
  assert.equal((await responseJson(invalid)).error, "invalid_json");

  const unsafe = await worker.fetch(jsonRequest("/chat", "POST", {
    session_id: "../other-session",
    message: "hello",
  }), baseEnv());
  assert.equal(unsafe.status, 400);
  assert.equal((await responseJson(unsafe)).error, "invalid_session_id");

  const oversized = await worker.fetch(jsonRequest("/chat", "POST", {
    session_id: "safe",
    message: "x".repeat(32769),
  }), baseEnv());
  assert.equal(oversized.status, 413);
  assert.equal((await responseJson(oversized)).error, "message_too_long");

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith("https://redis.example.test")) {
      const command = JSON.parse(init.body);
      return Response.json({ result: command[0] === "SET" ? "OK" : 1 });
    }
    if (String(url).includes("agent_messages?") && init.method === "GET") return Response.json([]);
    if (String(url).endsWith("/agent_messages")) return new Response(null, { status: 201 });
    if (String(url).startsWith("https://model.example.test")) return new Response("bad gateway", { status: 503 });
    throw new Error(`unexpected fetch: ${url}`);
  };
  const upstreamFailure = await worker.fetch(jsonRequest("/chat", "POST", {
    session_id: "safe",
    message: "hello",
  }), baseEnv());
  assert.equal(upstreamFailure.status, 502);
  assert.deepEqual(await responseJson(upstreamFailure), {
    error: "model_upstream_error",
    upstream_status: 503,
  });

  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith("https://redis.example.test")) {
      const command = JSON.parse(init.body);
      return Response.json({ result: command[0] === "SET" ? "OK" : 1 });
    }
    if (String(url).includes("agent_messages?") && init.method === "GET") return Response.json([]);
    if (String(url).endsWith("/agent_messages")) return new Response(null, { status: 201 });
    if (String(url).startsWith("https://model.example.test")) {
      return await new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const timeout = await worker.fetch(jsonRequest("/chat", "POST", {
    session_id: "safe",
    message: "hello",
  }), baseEnv({ UPSTREAM_TIMEOUT_MS: "5" }));
  assert.equal(timeout.status, 504);
  assert.equal((await responseJson(timeout)).error, "model_timeout");
});

test("JSON and R2 request bodies stop streaming and cancel once their byte limits are exceeded", async () => {
  function oversizedStream(chunks) {
    let index = 0;
    let cancelled = false;
    return {
      stream: new ReadableStream({
        pull(controller) {
          if (index >= chunks.length) {
            controller.close();
            return;
          }
          controller.enqueue(new TextEncoder().encode(chunks[index++]));
        },
        cancel() {
          cancelled = true;
        },
      }),
      wasCancelled: () => cancelled,
      chunksRead: () => index,
    };
  }

  const jsonBody = oversizedStream(Array.from({ length: 10 }, (_, index) => String(index).repeat(70_000)));
  const jsonResponse = await worker.fetch(request("/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: jsonBody.stream,
    duplex: "half",
  }), baseEnv());
  assert.equal(jsonResponse.status, 413);
  assert.deepEqual(await responseJson(jsonResponse), { error: "request_too_large" });
  assert.equal(jsonBody.wasCancelled(), true);
  assert.ok(jsonBody.chunksRead() < 10);

  let putCalled = false;
  const files = createR2();
  files.put = async () => { putCalled = true; };
  const fileBody = oversizedStream(Array.from({ length: 10 }, () => "1234"));
  const fileResponse = await worker.fetch(request("/files/large.bin", {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: fileBody.stream,
    duplex: "half",
  }), baseEnv({ FILES: files, MAX_FILE_BYTES: "5" }));
  assert.equal(fileResponse.status, 413);
  assert.deepEqual(await responseJson(fileResponse), { error: "file_too_large" });
  assert.equal(fileBody.wasCancelled(), true);
  assert.equal(putCalled, false);
});

test("chat bounds a model answer to the message storage limit before persisting it", async (t) => {
  const assistantInserts = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith("https://redis.example.test")) {
      const command = JSON.parse(init.body);
      return Response.json({ result: command[0] === "SET" ? "OK" : 1 });
    }
    if (String(url).includes("agent_messages?") && init.method === "GET") return Response.json([]);
    if (String(url).endsWith("/agent_messages") && init.method === "POST") {
      const record = JSON.parse(init.body);
      if (record.role === "assistant") assistantInserts.push(record);
      return new Response(null, { status: 201 });
    }
    if (String(url).startsWith("https://model.example.test")) {
      return Response.json({ choices: [{ message: { role: "assistant", content: "a".repeat(32_769) } }] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const response = await worker.fetch(jsonRequest("/chat", "POST", {
    session_id: "bounded-answer",
    message: "hello",
  }), baseEnv());
  assert.equal(response.status, 200);
  assert.equal(assistantInserts[0].content.length, 32_768);
  assert.equal((await responseJson(response)).choices[0].message.content.length, 32_768);
});

test("memory GET, POST, and DELETE use the scoped Supabase message table", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.method === "GET") return Response.json([{ role: "user", content: "hello" }]);
    if (init.method === "POST") return Response.json([{ id: "m1", role: "user", content: "remember" }], { status: 201 });
    return new Response(null, { status: 204 });
  };

  const getResponse = await worker.fetch(request("/memory?session_id=s1"), baseEnv());
  assert.equal(getResponse.status, 200);
  assert.deepEqual(await responseJson(getResponse), [{ role: "user", content: "hello" }]);

  const postResponse = await worker.fetch(jsonRequest("/memory", "POST", {
    session_id: "s1",
    role: "assistant",
    content: "remember",
  }), baseEnv());
  assert.equal(postResponse.status, 201);

  const deleteResponse = await worker.fetch(request("/memory?session_id=s1", { method: "DELETE" }), baseEnv());
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await responseJson(deleteResponse), { ok: true, session_id: "s1" });
  assert.match(calls.at(-1).url, /agent_messages\?session_id=eq\.s1/);
  assert.equal(calls.at(-1).init.method, "DELETE");
});

test("tasks can be listed, created, and patched through Supabase", async (t) => {
  const taskId = "a45b76ef-7198-4e0b-bb8c-b0cfe21dca2b";
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.method === "GET") return Response.json([{ id: taskId, title: "Ship", status: "pending" }]);
    const body = JSON.parse(init.body);
    return Response.json([{ id: taskId, ...body }], { status: init.method === "POST" ? 201 : 200 });
  };

  const listed = await worker.fetch(request("/tasks?status=pending"), baseEnv());
  assert.equal(listed.status, 200);
  assert.match(calls[0].url, /agent_tasks\?/);
  assert.match(calls[0].url, /status=eq\.pending/);

  const created = await worker.fetch(jsonRequest("/tasks", "POST", {
    title: "Ship",
    description: "Deploy safely",
    payload: { environment: "prod" },
  }), baseEnv());
  assert.equal(created.status, 201);
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    title: "Ship",
    description: "Deploy safely",
    status: "pending",
    payload: { environment: "prod" },
  });

  const patched = await worker.fetch(jsonRequest("/tasks", "PATCH", {
    id: taskId,
    status: "completed",
    result: { deployment: "ok" },
  }), baseEnv());
  assert.equal(patched.status, 200);
  assert.match(calls[3].url, new RegExp(`agent_tasks\\?id=eq\\.${taskId}`));
  assert.match(calls[3].url, /version=eq\.1/);
  assert.match(calls[3].url, /status=eq\.pending/);
  assert.deepEqual(JSON.parse(calls[3].init.body), {
    status: "completed",
    result: { deployment: "ok" },
    version: 2,
  });

  const invalid = await worker.fetch(jsonRequest("/tasks", "POST", {
    title: "x".repeat(201),
  }), baseEnv());
  assert.equal(invalid.status, 413);
});

test("task patches require a UUID and return 404 when Supabase updates no rows", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return Response.json([]);
  };

  const invalidId = await worker.fetch(jsonRequest("/tasks", "PATCH", {
    id: "task-1",
    status: "completed",
  }), baseEnv());
  assert.equal(invalidId.status, 400);
  assert.deepEqual(await responseJson(invalidId), { error: "invalid_task_id" });
  assert.equal(calls.length, 0);

  const missing = await worker.fetch(jsonRequest("/tasks", "PATCH", {
    id: "a45b76ef-7198-4e0b-bb8c-b0cfe21dca2b",
    status: "completed",
  }), baseEnv());
  assert.equal(missing.status, 404);
  assert.deepEqual(await responseJson(missing), { error: "task_not_found" });
  assert.equal(calls.length, 1);
});

test("task creation returns the existing row for a repeated idempotency_key", async (t) => {
  const taskId = "c61af71c-d749-4058-a36f-a7701bf3f427";
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("idempotency_key=eq.")) {
      return Response.json([{ id: taskId, title: "Existing", status: "pending", version: 1 }]);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const response = await worker.fetch(jsonRequest("/tasks", "POST", {
    title: "Existing",
    idempotency_key: "queue-item:123",
  }), baseEnv());
  assert.equal(response.status, 200);
  assert.deepEqual(await responseJson(response), [{ id: taskId, title: "Existing", status: "pending", version: 1 }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "GET");
});

test("task claim calls the atomic RPC and returns one claimed task", async (t) => {
  const task = {
    id: "c61af71c-d749-4058-a36f-a7701bf3f427",
    title: "Claim me",
    status: "running",
    version: 2,
  };
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return Response.json([task]);
  };

  const response = await worker.fetch(jsonRequest("/tasks/claim", "POST", {}), baseEnv());
  assert.equal(response.status, 200);
  assert.deepEqual(await responseJson(response), { task });
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/claim_agent_task$/);
  assert.equal(calls[0].init.method, "POST");
});

test("task patch uses version and expected status filters and reports stale conflicts", async (t) => {
  const taskId = "c61af71c-d749-4058-a36f-a7701bf3f427";
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.method === "PATCH") return Response.json([]);
    return Response.json([{ id: taskId, status: "running", version: 4 }]);
  };

  const response = await worker.fetch(jsonRequest("/tasks", "PATCH", {
    id: taskId,
    status: "completed",
    version: 3,
    expected_status: "running",
  }), baseEnv());
  assert.equal(response.status, 409);
  assert.deepEqual(await responseJson(response), { error: "task_conflict" });
  assert.match(calls[0].url, /id=eq\.[^&]+/);
  assert.match(calls[0].url, /version=eq\.3/);
  assert.match(calls[0].url, /status=eq\.running/);
  assert.deepEqual(JSON.parse(calls[0].init.body), { status: "completed", version: 4 });
  assert.equal(calls[1].init.method, "GET");
});

test("cache GET, PUT, and DELETE execute bounded Upstash commands", async (t) => {
  const commands = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init = {}) => {
    commands.push(JSON.parse(init.body));
    if (commands.at(-1)[0] === "GET") return Response.json({ result: "cached" });
    return Response.json({ result: "OK" });
  };

  const getResponse = await worker.fetch(request("/cache?key=session:1"), baseEnv());
  assert.equal(getResponse.status, 200);
  assert.deepEqual(await responseJson(getResponse), { key: "session:1", value: "cached" });

  const putResponse = await worker.fetch(jsonRequest("/cache", "PUT", {
    key: "session:1",
    value: { ok: true },
    ttl: 1,
  }), baseEnv());
  assert.equal(putResponse.status, 200);

  const deleteResponse = await worker.fetch(request("/cache?key=session:1", { method: "DELETE" }), baseEnv());
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(commands, [
    ["GET", "cache:session:1"],
    ["SET", "cache:session:1", '{"ok":true}', "EX", 30],
    ["DEL", "cache:session:1"],
  ]);

  const unsafe = await worker.fetch(request("/cache?key=../secret"), baseEnv());
  assert.equal(unsafe.status, 400);
  assert.equal((await responseJson(unsafe)).error, "invalid_key");
});

test("locks use SET NX EX and compare-and-delete release", async (t) => {
  const commands = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init = {}) => {
    const command = JSON.parse(init.body);
    commands.push(command);
    return Response.json({ result: command[0] === "SET" ? "OK" : 1 });
  };

  const acquired = await worker.fetch(jsonRequest("/locks/acquire", "POST", {
    key: "job:1",
    token: "owner-token",
    ttl: 45,
  }), baseEnv());
  assert.equal(acquired.status, 200);
  assert.deepEqual(await responseJson(acquired), { acquired: true, key: "job:1" });

  const released = await worker.fetch(jsonRequest("/locks/release", "POST", {
    key: "job:1",
    token: "owner-token",
  }), baseEnv());
  assert.equal(released.status, 200);
  assert.deepEqual(await responseJson(released), { released: true, key: "job:1" });

  assert.deepEqual(commands[0], ["SET", "lock:job:1", "owner-token", "NX", "EX", 45]);
  assert.equal(commands[1][0], "EVAL");
  assert.match(commands[1][1], /redis\.call\(['"]GET['"]/);
  assert.deepEqual(commands[1].slice(2), [1, "lock:job:1", "owner-token"]);
});

test("R2 files support list, put, get, delete and reject unsafe keys", async () => {
  const env = baseEnv();
  const put = await worker.fetch(request("/files/folder/note.txt", {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: "hello",
  }), env);
  assert.equal(put.status, 200);

  const list = await worker.fetch(request("/files"), env);
  assert.deepEqual((await responseJson(list)).objects.map((object) => object.key), ["folder/note.txt"]);

  const get = await worker.fetch(request("/files/folder/note.txt"), env);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("content-type"), "text/plain");
  assert.equal(await get.text(), "hello");

  const unsafe = await worker.fetch(request("/files/%00secret", { method: "GET" }), env);
  assert.equal(unsafe.status, 400);
  assert.equal((await responseJson(unsafe)).error, "invalid_file_key");

  const deleted = await worker.fetch(request("/files/folder/note.txt", { method: "DELETE" }), env);
  assert.equal(deleted.status, 200);
  const missing = await worker.fetch(request("/files/folder/note.txt"), env);
  assert.equal(missing.status, 404);
});

test("R2 file listing forwards a safe cursor for the next page", async () => {
  const listOptions = [];
  const files = createR2();
  files.list = async (options) => {
    listOptions.push(options);
    if (!options.cursor) {
      return {
        objects: [{ key: "first.txt", size: 1, uploaded: new Date("2026-08-17T00:00:00Z") }],
        truncated: true,
        cursor: "next-page_1=",
      };
    }
    return {
      objects: [{ key: "second.txt", size: 2, uploaded: new Date("2026-08-17T00:01:00Z") }],
      truncated: false,
    };
  };
  const env = baseEnv({ FILES: files });

  const first = await worker.fetch(request("/files"), env);
  assert.equal(first.status, 200);
  assert.equal((await responseJson(first)).cursor, "next-page_1=");

  const next = await worker.fetch(request("/files?cursor=next-page_1%3D"), env);
  assert.equal(next.status, 200);
  assert.deepEqual((await responseJson(next)).objects.map((object) => object.key), ["second.txt"]);
  assert.deepEqual(listOptions, [
    { limit: 100 },
    { limit: 100, cursor: "next-page_1=" },
  ]);

  const unsafe = await worker.fetch(request(`/files?cursor=${encodeURIComponent("<unsafe>")}`), env);
  assert.equal(unsafe.status, 400);
  assert.deepEqual(await responseJson(unsafe), { error: "invalid_cursor" });
  assert.equal(listOptions.length, 2);
});

test("integration failures are normalized instead of leaking provider responses", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("https://db.example.test")) {
      return Response.json({ message: "database detail that should stay private" }, { status: 500 });
    }
    return Response.json({ error: "redis detail" }, { status: 500 });
  };

  const memory = await worker.fetch(request("/memory?session_id=s1"), baseEnv());
  assert.equal(memory.status, 502);
  assert.deepEqual(await responseJson(memory), {
    error: "supabase_upstream_error",
    upstream_status: 500,
  });

  const cache = await worker.fetch(request("/cache?key=safe"), baseEnv({
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
  }));
  assert.equal(cache.status, 502);
  assert.deepEqual(await responseJson(cache), {
    error: "upstash_upstream_error",
    upstream_status: 500,
  });
});

test("Supabase 2xx non-JSON responses are normalized as invalid upstream responses", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("provider maintenance page", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });

  const response = await worker.fetch(request("/memory?session_id=s1"), baseEnv());
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error: "invalid_upstream_response" });
  assert.doesNotMatch(text, /maintenance/);
});

test("cache rejects Upstash 2xx non-JSON responses without leaking the body", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("private redis proxy error", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });

  const response = await worker.fetch(request("/cache?key=safe"), baseEnv());
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error: "invalid_upstream_response" });
  assert.doesNotMatch(text, /private redis proxy error/);
});

test("lock acquire rejects Upstash JSON without an own result field", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({ detail: "private redis response" });

  const response = await worker.fetch(jsonRequest("/locks/acquire", "POST", {
    key: "job:1",
    token: "owner-token",
    ttl: 45,
  }), baseEnv());
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error: "invalid_upstream_response" });
  assert.doesNotMatch(text, /private redis response/);
});

test("top-level provider errors include x-request-id and log only safe request metadata", async (t) => {
  const traceId = "7458d4b1-df2b-4123-a65d-fb3e139774ec";
  const logs = [];
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  });
  console.error = (...args) => logs.push(args);
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith("https://redis.example.test")) {
      const command = JSON.parse(init.body);
      return Response.json({ result: command[0] === "SET" ? "OK" : 1 });
    }
    if (String(url).includes("agent_messages?") && init.method === "GET") return Response.json([]);
    if (String(url).endsWith("/agent_messages") && init.method === "POST") return new Response(null, { status: 201 });
    if (String(url).startsWith("https://model.example.test")) return new Response("secret upstream body", { status: 503 });
    throw new Error(`unexpected fetch: ${url}`);
  };

  const response = await worker.fetch(jsonRequest("/chat", "POST", {
    session_id: "trace-session",
    message: "hello",
  }, true, { "x-request-id": traceId }), baseEnv({
    INTERNAL_API_TOKEN: "do-not-log-this-token",
    MODEL_API_KEY: "do-not-log-this-model-key",
  }));
  assert.equal(response.status, 401);

  const authorizedResponse = await worker.fetch(jsonRequest("/chat", "POST", {
    session_id: "trace-session",
    message: "hello",
  }, false, {
    authorization: "Bearer do-not-log-this-token",
    "x-request-id": traceId,
  }), baseEnv({
    INTERNAL_API_TOKEN: "do-not-log-this-token",
    MODEL_API_KEY: "do-not-log-this-model-key",
  }));
  assert.equal(authorizedResponse.status, 502);
  assert.equal(authorizedResponse.headers.get("x-request-id"), traceId);
  assert.equal(logs.length, 1);
  const logged = JSON.stringify(logs[0]);
  assert.match(logged, new RegExp(traceId));
  assert.match(logged, /\/chat/);
  assert.match(logged, /model_upstream_error/);
  assert.doesNotMatch(logged, /do-not-log-this|secret upstream body|hello/);
});

test("Supabase schema creates messages, tasks, vector knowledge, and match RPC", async () => {
  const schema = await readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8");
  assert.match(schema, /create extension if not exists vector/i);
  assert.match(schema, /create table if not exists public\.agent_messages/i);
  assert.match(schema, /create table if not exists public\.agent_tasks/i);
  assert.match(schema, /create table if not exists public\.agent_knowledge/i);
  assert.match(schema, /embedding\s+extensions\.vector\(1024\)/i);
  assert.match(schema, /create or replace function public\.match_agent_knowledge/i);
  assert.match(schema, /turn_id\s+uuid/i);
  assert.match(schema, /unique[^\n]*\(turn_id,\s*role\)|unique index[^\n]*[\s\S]*\(turn_id,\s*role\)/i);
  assert.match(schema, /idempotency_key\s+text/i);
  assert.match(schema, /version\s+bigint[^\n]*default\s+1/i);
  assert.match(schema, /create or replace function public\.claim_agent_task/i);
  assert.match(schema, /skip locked/i);
  assert.match(schema, /agent_tasks_due_at/i);
  assert.match(schema, /set_agent_knowledge_updated_at/i);
  assert.match(schema, /revoke all on public\.agent_messages from public, anon, authenticated/i);
});
