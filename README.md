# wangdada-agent-api

一个不依赖 Hugging Face 计算型 Space 的轻量 Cloudflare Worker：

仓库同时包含 `streamlit_app.py`，可直接部署到 Streamlit Community Cloud 作为聊天前端。

- `GET /health`：健康检查
- `GET /files`：列出 R2 文件
- `PUT /files/<key>`：上传文件到 R2
- `GET /files/<key>`：读取文件
- `DELETE /files/<key>`：删除文件
- `POST /chat`：通过 OpenAI 兼容接口调用外部模型
- `GET|POST /memory`：可选写入/读取 Supabase `agent_messages`
- `GET|PUT /cache`：可选读写 Upstash Redis

文件和模型接口默认受保护；未配置密钥时不会暴露 R2，也不会消耗模型额度。

## 模型配置

不要把密钥写进代码。部署后再配置以下 Worker Secrets：

- `MODEL_API_URL`
- `MODEL_API_KEY`
- `MODEL_NAME`（可选）

还需要配置：

- `INTERNAL_API_TOKEN`

## 可选持久化与缓存

Worker 不会把第三方密钥写入代码。要启用完整链路，在 Cloudflare Worker Secrets 中配置：

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Supabase 需要先创建 `public.agent_messages` 表；没有这些配置时，R2、健康检查和前端仍可运行，记忆/缓存接口会返回未配置状态。

没有模型密钥时，`/health` 和 R2 文件接口仍然可用，`/chat` 会返回 `503 model_not_configured`。
