import { fetchProvider } from "./helpers.js";

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

async function supabaseQuery(env, table, options = {}) {
  const url = new URL(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${table}`);
  if (options.searchParams) {
    for (const [key, value] of Object.entries(options.searchParams)) {
      url.searchParams.set(key, value);
    }
  }
  const response = await fetchProvider("supabase", url.toString(), {
    method: options.method || "GET",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      prefer: options.prefer || "return=representation",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  }, 15_000);
  if (!response.ok) throw new Error(`supabase_${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : [];
}

async function getBot(env, botId) {
  const rows = await supabaseQuery(env, "agent_bots", {
    searchParams: { id: `eq.${botId}`, select: "*" },
  });
  return rows[0] || null;
}

async function getChannel(env, channelId) {
  const rows = await supabaseQuery(env, "agent_channels", {
    searchParams: { id: `eq.${channelId}`, select: "*" },
  });
  return rows[0] || null;
}

async function getChannelMessages(env, channelId, limit = 50) {
  return supabaseQuery(env, "agent_messages", {
    searchParams: {
      channel_id: `eq.${channelId}`,
      select: "role,content,bot_id,created_at",
      order: "created_at.asc",
      limit: String(limit),
    },
  });
}

async function saveMessage(env, record) {
  return supabaseQuery(env, "agent_messages", { method: "POST", body: record });
}

function extractMentions(text, bots) {
  const mentioned = [];
  for (const bot of bots) {
    if (text.includes(`@${bot.name}`)) mentioned.push(bot);
  }
  return mentioned;
}

async function callModelForBot(env, bot, history, userMessage) {
  const systemContent = [
    bot.system_prompt || "",
    bot.role_description ? `你的职责：${bot.role_description}` : "",
    `你叫"${bot.name}"，是群聊中的一个 AI 助手。`,
    "如果需要其他 Bot 帮忙，在回复中用 @Bot名 提及它们。",
  ].filter(Boolean).join("\n");

  const messages = [
    { role: "system", content: systemContent },
    ...history.map((m) => ({
      role: m.bot_id ? "assistant" : m.role === "user" ? "user" : "assistant",
      content: m.bot_id ? `[${m.role}] ${m.content}` : m.content,
    })),
    { role: "user", content: userMessage },
  ];

  const upstream = await fetchProvider("model", env.MODEL_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.MODEL_API_KEY}`,
    },
    body: JSON.stringify({ model: bot.model, messages }),
  }, 30_000);

  if (!upstream.ok) throw new Error(`model_${upstream.status}`);
  const payload = await upstream.json();
  return payload?.choices?.[0]?.message?.content || "(无回复)";
}

export async function handleMultiBot(request, env, url) {
  const path = url.pathname;

  // GET /bots - list all bots
  if (path === "/bots" && request.method === "GET") {
    const bots = await supabaseQuery(env, "agent_bots", {
      searchParams: { select: "*", order: "created_at.asc" },
    });
    return json(bots);
  }

  // POST /bots - create a bot
  if (path === "/bots" && request.method === "POST") {
    const body = await request.json();
    const [bot] = await supabaseQuery(env, "agent_bots", { method: "POST", body });
    return json(bot, 201);
  }

  // PATCH /bots/:id
  if (path.startsWith("/bots/") && request.method === "PATCH") {
    const id = path.split("/")[2];
    const body = await request.json();
    const [bot] = await supabaseQuery(env, "agent_bots", {
      method: "PATCH",
      searchParams: { id: `eq.${id}` },
      body,
    });
    return json(bot);
  }

  // DELETE /bots/:id
  if (path.startsWith("/bots/") && request.method === "DELETE") {
    const id = path.split("/")[2];
    await supabaseQuery(env, "agent_bots", {
      method: "DELETE",
      searchParams: { id: `eq.${id}` },
      prefer: "return=minimal",
    });
    return json({ ok: true });
  }

  // GET /channels - list channels with bot details
  if (path === "/channels" && request.method === "GET") {
    const channels = await supabaseQuery(env, "agent_channels", {
      searchParams: { select: "*", order: "created_at.asc" },
    });
    const allBots = await supabaseQuery(env, "agent_bots", { searchParams: { select: "*" } });
    const botMap = Object.fromEntries(allBots.map((b) => [b.id, b]));
    for (const ch of channels) {
      ch.bots = (ch.bot_ids || []).map((id) => botMap[id]).filter(Boolean);
    }
    return json(channels);
  }

  // POST /channels - create a channel
  if (path === "/channels" && request.method === "POST") {
    const body = await request.json();
    const [channel] = await supabaseQuery(env, "agent_channels", { method: "POST", body });
    return json(channel, 201);
  }

  // POST /chat/group - send message to group channel
  if (path === "/chat/group" && request.method === "POST") {
    const body = await request.json();
    const { channel_id, message } = body;
    if (!channel_id || !message?.trim()) {
      return json({ error: "channel_id and message required" }, 400);
    }

    const channel = await getChannel(env, channel_id);
    if (!channel) return json({ error: "channel_not_found" }, 404);

    const botIds = channel.bot_ids || [];
    if (!botIds.length) return json({ error: "no_bots_in_channel" }, 400);

    const bots = [];
    for (const bid of botIds) {
      const bot = await getBot(env, bid);
      if (bot && bot.is_active) bots.push(bot);
    }

    const history = await getChannelMessages(env, channel_id);
    const mentioned = extractMentions(message, bots);
    const responders = mentioned.length ? mentioned : bots.slice(0, 1);

    // Save user message first
    await saveMessage(env, {
      session_id: `group:${channel_id}`,
      channel_id,
      role: "user",
      content: message.trim(),
    });

    // Get each mentioned/first bot to respond sequentially
    const replies = [];
    let currentHistory = [...history];

    for (const bot of responders) {
      const replyText = await callModelForBot(env, bot, currentHistory, message.trim());
      const saved = await saveMessage(env, {
        session_id: `group:${channel_id}`,
        channel_id,
        bot_id: bot.id,
        role: "assistant",
        content: replyText,
      });
      replies.push({ ...saved[0], bot_name: bot.name, bot_color: bot.color, avatar_emoji: bot.avatar_emoji });
      currentHistory.push({ role: "assistant", content: replyText, bot_id: bot.id });
    }

    // Check if any reply mentions other bots not yet responded -> chain them
    for (const reply of replies) {
      const chainMentions = extractMentions(reply.content, bots).filter(
        (b) => !responders.some((r) => r.id === b.id)
      );
      for (const chainedBot of chainMentions.slice(0, 2)) {
        const chainReply = await callModelForBot(env, chainedBot, currentHistory, reply.content);
        const chainSaved = await saveMessage(env, {
          session_id: `group:${channel_id}`,
          channel_id,
          bot_id: chainedBot.id,
          role: "assistant",
          content: chainReply,
        });
        replies.push({
          ...chainSaved[0],
          bot_name: chainedBot.name,
          bot_color: chainedBot.color,
          avatar_emoji: chainedBot.avatar_emoji,
        });
        currentHistory.push({ role: "assistant", content: chainReply, bot_id: chainedBot.id });
      }
    }

    return json({ ok: true, replies });
  }

  // GET /chat/group?channel_id=xxx - get group messages
  if (path === "/chat/group" && request.method === "GET") {
    const channelId = url.searchParams.get("channel_id");
    if (!channelId) return json({ error: "channel_id required" }, 400);

    const messages = await getChannelMessages(env, channelId, 100);
    const enriched = [];
    for (const msg of messages) {
      const item = { ...msg };
      if (msg.bot_id) {
        const bot = await getBot(env, msg.bot_id);
        if (bot) {
          item.bot_name = bot.name;
          item.bot_color = bot.color;
          item.avatar_emoji = bot.avatar_emoji;
        }
      }
      enriched.push(item);
    }
    return json(enriched);
  }

  return json({ error: "not_found" }, 404);
}
