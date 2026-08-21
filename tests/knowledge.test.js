import assert from "node:assert/strict";
import test from "node:test";

import {
  buildKnowledgeContext,
  handleKnowledgeRequest,
} from "../src/knowledge.js";

const API = "https://agent.example.test";

function jsonRequest(path, method, body) {
  return new Request(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function aiEnv(result = { data: [[0.25, ...Array(1023).fill(0)]] }) {
  const calls = [];
  return {
    env: {
      AI: {
        async run(model, input) {
          calls.push({ model, input });
          return typeof result === "function" ? result(model, input) : result;
        },
      },
      SUPABASE_URL: "https://db.example.test",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
    },
    calls,
  };
}

function responseJson(response) {
  return response.json();
}

test("POST /knowledge chunks Chinese content with overlap and batch-inserts embeddings", async () => {
  const { env, calls } = aiEnv((model, input) => ({
    data: input.text.map(() => [0.25, ...Array(1023).fill(0)]),
  }));
  const inserts = [];
  const helpers = {
    async supabaseRequest(_env, resource, init = {}) {
      inserts.push({ resource, init });
      return new Response(null, { status: 201 });
    },
  };
  const content = Array.from({ length: 360 }, (_, index) => `第${index}句，中文知识内容用于测试分块。`).join("");

  const response = await handleKnowledgeRequest(
    jsonRequest("/knowledge", "POST", { content, metadata: { source: "notes.md", topic: "测试" } }),
    env,
    new URL(`${API}/knowledge`),
    helpers,
  );

  assert.equal(response.status, 201);
  const result = await responseJson(response);
  assert.equal(result.ok, true);
  assert.ok(result.count > 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "@cf/baai/bge-m3");
  assert.equal(calls[0].input.text.length, result.count);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].resource, "agent_knowledge");
  const records = JSON.parse(inserts[0].init.body);
  assert.equal(records.length, result.count);
  assert.equal(records[0].metadata.source, "notes.md");
  assert.equal(records[0].metadata.chunk_index, 0);
  assert.equal(records.at(-1).metadata.chunk_count, result.count);
  assert.equal(records.every((record) => record.embedding.length === 1024), true);
  assert.equal(records[0].content.slice(-150), records[1].content.slice(0, 150));
});

test("knowledge rejects embeddings that are not exactly 1024 finite dimensions", async () => {
  const { env } = aiEnv({ data: [[1, 2, 3]] });
  const response = await handleKnowledgeRequest(
    jsonRequest("/knowledge", "POST", { content: "需要向量校验" }),
    env,
    new URL(`${API}/knowledge`),
    { async supabaseRequest() { throw new Error("must not insert"); } },
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await responseJson(response), { error: "invalid_ai_response" });
});

test("GET /knowledge/search embeds the query and calls the Supabase match RPC", async () => {
  const { env, calls } = aiEnv();
  const requests = [];
  const helpers = {
    async supabaseRequest(_env, resource, init = {}) {
      requests.push({ resource, init });
      return Response.json([
        { id: "a", content: "向量命中的内容", metadata: { source: "guide.md" }, similarity: 0.91 },
      ]);
    },
  };

  const response = await handleKnowledgeRequest(
    new Request(`${API}/knowledge/search?query=${encodeURIComponent("如何部署")}&limit=5&threshold=0.8`),
    env,
    new URL(`${API}/knowledge/search?query=${encodeURIComponent("如何部署")}&limit=5&threshold=0.8`),
    helpers,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await responseJson(response), {
    query: "如何部署",
    results: [{ id: "a", content: "向量命中的内容", metadata: { source: "guide.md" }, similarity: 0.91 }],
  });
  assert.equal(calls[0].input.text[0], "如何部署");
  assert.equal(requests[0].resource, "rpc/match_agent_knowledge");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    query_embedding: [0.25, ...Array(1023).fill(0)],
    match_threshold: 0.8,
    match_count: 5,
    metadata_filter: {},
  });
});

test("DELETE /knowledge/:uuid deletes one row and returns not found for an unknown UUID", async () => {
  const { env } = aiEnv();
  const calls = [];
  const helpers = {
    async supabaseRequest(_env, resource, init = {}) {
      calls.push({ resource, init });
      return Response.json([{ id: "a45b76ef-7198-4e0b-bb8c-b0cfe21dca2b" }]);
    },
  };
  const id = "a45b76ef-7198-4e0b-bb8c-b0cfe21dca2b";
  const response = await handleKnowledgeRequest(
    new Request(`${API}/knowledge/${id}`, { method: "DELETE" }),
    env,
    new URL(`${API}/knowledge/${id}`),
    helpers,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await responseJson(response), { ok: true, id });
  assert.equal(calls[0].resource, `agent_knowledge?id=eq.${id}`);
  assert.equal(calls[0].init.method, "DELETE");
});

test("buildKnowledgeContext includes sources and never exceeds 6000 characters", async () => {
  const { env } = aiEnv();
  const helpers = {
    async supabaseRequest() {
      return Response.json([
        { id: "1", content: "甲".repeat(4000), metadata: { source: "第一篇.md" }, similarity: 0.95 },
        { id: "2", content: "乙".repeat(4000), metadata: { title: "第二篇" }, similarity: 0.9 },
      ]);
    },
  };

  const context = await buildKnowledgeContext("查询", env, helpers);
  assert.ok(context.includes("第一篇.md"));
  assert.ok(context.includes("第二篇"));
  assert.ok(context.length <= 6000);
});

test("knowledge normalizes oversized input, missing configuration, and upstream failures", async () => {
  const oversized = await handleKnowledgeRequest(
    jsonRequest("/knowledge", "POST", { content: "x".repeat(600_000) }),
    { AI: { run: async () => ({ data: [] }) } },
    new URL(`${API}/knowledge`),
    {},
  );
  assert.equal(oversized.status, 413);
  assert.deepEqual(await responseJson(oversized), { error: "request_too_large" });

  const missing = await handleKnowledgeRequest(
    jsonRequest("/knowledge", "POST", { content: "hello" }),
    {},
    new URL(`${API}/knowledge`),
    {},
  );
  assert.equal(missing.status, 503);
  assert.deepEqual(await responseJson(missing), { error: "knowledge_not_configured" });

  const failure = await handleKnowledgeRequest(
    jsonRequest("/knowledge", "POST", { content: "hello" }),
    aiEnv().env,
    new URL(`${API}/knowledge`),
    {
      async supabaseRequest() {
        return new Response("private details", { status: 500 });
      },
    },
  );
  assert.equal(failure.status, 502);
  assert.deepEqual(await responseJson(failure), { error: "supabase_upstream_error" });
});
