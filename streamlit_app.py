"""单用户 Wangdada Agent 控制台。

本模块中的网络和数据构造辅助函数不依赖 Streamlit，便于用纯 Python 测试。
"""

from __future__ import annotations

import io
import json
import os
import re
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterable, Mapping, Optional
from urllib.parse import quote

import requests

try:  # 让辅助函数在未安装 Streamlit 的 CI 环境中仍可导入和测试。
    import streamlit as st
except ModuleNotFoundError:  # pragma: no cover - 仅用于纯 Python 测试环境
    st = None

try:
    from pypdf import PdfReader
except ModuleNotFoundError:  # pragma: no cover - 运行时由 requirements.txt 提供
    PdfReader = None


DEFAULT_API_URL = "https://wangdada-agent-api.wangdada-substracker.workers.dev"
REQUEST_TIMEOUT_SECONDS = 60
UPLOAD_PREFIX = "uploads/"
ALLOWED_UPLOAD_EXTENSIONS = {"txt", "md", "pdf"}
TASK_STATUSES = ("pending", "running", "completed", "failed", "cancelled")
SAFE_SESSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


@dataclass(frozen=True)
class ApiResult:
    """已解析的 API 响应，不包含请求头或令牌。"""

    ok: bool
    status_code: int
    data: Any
    text: str = ""
    error: str = ""


def configured_secret(name: str, default: str = "") -> str:
    """优先读取 Streamlit Secrets，再使用环境变量；永不显示调用结果。"""
    if st is not None:
        try:
            value = st.secrets.get(name)
            if value is not None:
                return str(value)
        except Exception:
            # 本地未配置 secrets.toml 时回退到环境变量。
            pass
    return os.getenv(name, default)


def safe_filename(filename: str, fallback: str = "file") -> str:
    """移除路径片段、控制字符与不适合作为 R2 key 的字符。"""
    raw = unicodedata.normalize("NFKC", str(filename or "")).replace("\\", "/")
    raw = raw.split("/")[-1].strip().lstrip(".")
    raw = "".join(char for char in raw if char.isprintable() and char not in "/\\")
    raw = re.sub(r"\s+", " ", raw)
    raw = re.sub(r"[^\w. -]", "_", raw, flags=re.UNICODE).strip(" .")
    if raw in {"", ".", ".."}:
        return fallback
    return raw[:180]


def make_upload_key(filename: str, prefix: str = UPLOAD_PREFIX, unique_id: Optional[str] = None) -> str:
    """构造固定 uploads/ 前缀、无目录穿越且避免同名覆盖的对象 key。"""
    normalized_prefix = prefix.strip().strip("/") or "uploads"
    token = unique_id or uuid.uuid4().hex
    return f"{normalized_prefix}/{token}-{safe_filename(filename)}"


def filename_extension(filename: str) -> str:
    return safe_filename(filename).rsplit(".", 1)[-1].lower() if "." in safe_filename(filename) else ""


def build_chat_payload(message: str, session_id: str, request_id: Optional[str] = None) -> dict[str, str]:
    text = str(message).strip()
    if not text:
        raise ValueError("消息不能为空")
    if not SAFE_SESSION_RE.fullmatch(session_id):
        raise ValueError("会话 ID 仅支持字母、数字、. _ : -，最长 128 位")
    return {
        "message": text,
        "session_id": session_id,
        "request_id": request_id or str(uuid.uuid4()),
    }


def build_task_payload(
    title: str,
    description: str = "",
    due_at: Optional[str] = None,
    idempotency_key: Optional[str] = None,
) -> dict[str, Any]:
    clean_title = str(title).strip()
    if not clean_title:
        raise ValueError("任务标题不能为空")
    payload: dict[str, Any] = {"title": clean_title, "description": str(description).strip()}
    if due_at:
        payload["due_at"] = str(due_at)
    if idempotency_key:
        payload["idempotency_key"] = str(idempotency_key).strip()
    return payload


def build_task_update_payload(task_id: str, status: str, version: Any) -> dict[str, Any]:
    if not str(task_id).strip():
        raise ValueError("任务 ID 不能为空")
    if status not in TASK_STATUSES:
        raise ValueError("无效的任务状态")
    if version in (None, ""):
        raise ValueError("更新任务必须提供 version")
    return {"id": str(task_id).strip(), "status": status, "version": version}


def build_knowledge_payload(content: str, source_name: str = "", metadata: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
    text = str(content).strip()
    if not text:
        raise ValueError("知识内容不能为空")
    result_metadata = dict(metadata or {})
    if source_name:
        result_metadata["source"] = safe_filename(source_name)
    return {"content": text, "metadata": result_metadata}


def parse_api_response(status_code: int, text: str, content_type: str = "") -> ApiResult:
    """无论上游返回 JSON、文本或空体，都提供稳定且可展示的结果。"""
    body = text or ""
    data: Any = None
    looks_json = "json" in content_type.lower() or body.lstrip().startswith(("{", "["))
    if body and looks_json:
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            data = None
    if data is None and body:
        data = body
    ok = 200 <= int(status_code) < 300
    error = "" if ok else api_error_message(status_code, data, body)
    return ApiResult(ok=ok, status_code=int(status_code), data=data, text=body, error=error)


def api_error_message(status_code: int, data: Any, fallback: str = "") -> str:
    """提取可读错误，不把 headers（可能包含机密）带入 UI。"""
    detail = ""
    if isinstance(data, Mapping):
        for key in ("error", "message", "detail"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                detail = value.strip()
                break
    elif isinstance(data, str):
        detail = data.strip()
    if not detail:
        detail = str(fallback).strip()
    return f"请求失败（HTTP {status_code}）" + (f"：{detail[:500]}" if detail else "")


def api_request(
    api_base: str,
    token: str,
    method: str,
    path: str,
    *,
    params: Optional[Mapping[str, Any]] = None,
    json_body: Any = None,
    content: Optional[bytes] = None,
    content_type: Optional[str] = None,
    expect_bytes: bool = False,
) -> ApiResult:
    """所有控制台请求统一使用 Bearer 鉴权和固定超时。"""
    if not token:
        return ApiResult(False, 0, None, error="未配置 INTERNAL_API_TOKEN")
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if content_type:
        headers["Content-Type"] = content_type
    try:
        response = requests.request(
            method=method.upper(),
            url=f"{api_base.rstrip('/')}/{path.lstrip('/')}",
            headers=headers,
            params=dict(params or {}),
            json=json_body,
            data=content,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        if expect_bytes:
            if 200 <= response.status_code < 300:
                return ApiResult(True, response.status_code, response.content)
            return parse_api_response(
                response.status_code,
                response.text,
                response.headers.get("content-type", ""),
            )
        return parse_api_response(
            response.status_code,
            response.text,
            response.headers.get("content-type", ""),
        )
    except requests.RequestException as exc:
        return ApiResult(False, 0, None, error=f"网络请求失败：{exc.__class__.__name__}")


def extract_pdf_text(file_bytes: bytes) -> str:
    if PdfReader is None:
        raise RuntimeError("未安装 pypdf，无法提取 PDF 文本")
    reader = PdfReader(io.BytesIO(file_bytes))
    return "\n\n".join((page.extract_text() or "").strip() for page in reader.pages).strip()


def extract_knowledge_text(file_name: str, file_bytes: bytes) -> str:
    extension = filename_extension(file_name)
    if extension not in ALLOWED_UPLOAD_EXTENSIONS:
        raise ValueError("仅支持 TXT、MD 或 PDF 文件")
    if extension == "pdf":
        return extract_pdf_text(file_bytes)
    return file_bytes.decode("utf-8", errors="replace").strip()


def format_bytes(size: Any) -> str:
    try:
        number = float(size)
    except (TypeError, ValueError):
        return "—"
    for unit in ("B", "KB", "MB", "GB"):
        if number < 1024 or unit == "GB":
            return f"{number:.0f} {unit}" if unit == "B" else f"{number:.1f} {unit}"
        number /= 1024
    return "—"


def format_time(value: Any) -> str:
    if not value:
        return "—"
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return str(value)


def ensure_state() -> None:
    if "api_base" not in st.session_state:
        st.session_state.api_base = configured_secret("AGENT_API_URL", DEFAULT_API_URL).rstrip("/")
    if "cache_api_base" not in st.session_state:
        st.session_state.cache_api_base = st.session_state.api_base
    if "api_token" not in st.session_state:
        # 仅在当前浏览器会话保存令牌，不写入消息、控件默认值或日志。
        st.session_state.api_token = configured_secret("INTERNAL_API_TOKEN")
    if "session_id" not in st.session_state:
        st.session_state.session_id = f"session-{uuid.uuid4()}"
    if "messages" not in st.session_state:
        st.session_state.messages = []
    if "memory_loaded_for" not in st.session_state:
        st.session_state.memory_loaded_for = None
    st.session_state.setdefault("files_page", None)
    st.session_state.setdefault("file_cursors", [])
    st.session_state.setdefault("file_downloads", {})
    st.session_state.setdefault("tasks", None)
    st.session_state.setdefault("knowledge_results", None)


def require_token() -> bool:
    if st.session_state.api_token:
        return True
    st.error("未找到访问令牌。请在 Streamlit Secrets 或环境变量中设置 INTERNAL_API_TOKEN。")
    return False


def load_memory_once() -> None:
    session_id = st.session_state.session_id
    if st.session_state.memory_loaded_for == session_id:
        return
    if not st.session_state.api_token:
        return
    result = api_request(
        st.session_state.api_base,
        st.session_state.api_token,
        "GET",
        "/memory",
        params={"session_id": session_id, "limit": 100},
    )
    if result.ok and isinstance(result.data, list):
        st.session_state.messages = [
            {"role": item.get("role", "assistant"), "content": item.get("content", "")}
            for item in result.data
            if isinstance(item, Mapping) and item.get("role") in {"user", "assistant", "system"}
        ]
    elif not result.ok:
        st.warning(f"未能读取历史消息：{result.error}")
    st.session_state.memory_loaded_for = session_id


def render_sidebar() -> None:
    with st.sidebar:
        st.header("控制台")
        st.caption("单用户 Agent 工作台")
        current_api_base = st.text_input("Agent API 地址", key="api_base", help="默认从 AGENT_API_URL 自动读取。").rstrip("/")
        if current_api_base and current_api_base != st.session_state.cache_api_base:
            # 端点切换后不能复用另一个服务的历史、文件或任务缓存。
            st.session_state.api_base = current_api_base
            st.session_state.cache_api_base = current_api_base
            st.session_state.messages = []
            st.session_state.memory_loaded_for = None
            st.session_state.files_page = None
            st.session_state.file_cursors = []
            st.session_state.file_downloads = {}
            st.session_state.tasks = None
            st.session_state.knowledge_results = None
            st.rerun()
        previous = st.session_state.session_id
        candidate = st.text_input(
            "会话名称 / ID",
            value=previous,
            help="支持字母、数字、. _ : -；变更后会切换到新的持久会话。",
        ).strip()
        if candidate and candidate != previous:
            if SAFE_SESSION_RE.fullmatch(candidate):
                st.session_state.session_id = candidate
                st.session_state.messages = []
                st.session_state.memory_loaded_for = None
                st.rerun()
            else:
                st.caption("会话 ID 格式无效；当前会话未改变。")

        if st.button("检查健康状态", use_container_width=True):
            if require_token():
                health = api_request(
                    st.session_state.api_base,
                    st.session_state.api_token,
                    "GET",
                    "/health",
                )
                if health.ok:
                    st.success("服务可访问")
                    st.json(health.data)
                else:
                    st.error(health.error)
        st.caption("访问令牌已从 Secrets 读取，仅保存在本次浏览器会话中。")


def render_chat() -> None:
    load_memory_once()
    st.subheader("对话")
    st.caption(f"会话：`{st.session_state.session_id}`")
    clear_col, _ = st.columns((1, 2))
    with clear_col:
        if st.button("清空当前会话记忆", type="secondary", use_container_width=True):
            if require_token():
                result = api_request(
                    st.session_state.api_base,
                    st.session_state.api_token,
                    "DELETE",
                    "/memory",
                    params={"session_id": st.session_state.session_id},
                )
                if result.ok:
                    st.session_state.messages = []
                    st.session_state.memory_loaded_for = st.session_state.session_id
                    st.success("已清空当前会话记忆。")
                else:
                    st.error(result.error)

    for message in st.session_state.messages:
        with st.chat_message(message["role"]):
            st.markdown(message["content"])

    prompt = st.chat_input("输入消息")
    if not prompt:
        return
    st.session_state.messages.append({"role": "user", "content": prompt})
    with st.chat_message("user"):
        st.markdown(prompt)
    if not require_token():
        answer = "尚未配置访问令牌，无法调用 Agent API。"
    else:
        try:
            payload = build_chat_payload(prompt, st.session_state.session_id)
            with st.spinner("Agent 正在处理…"):
                result = api_request(
                    st.session_state.api_base,
                    st.session_state.api_token,
                    "POST",
                    "/chat",
                    json_body=payload,
                )
            if result.ok and isinstance(result.data, Mapping):
                choices = result.data.get("choices") or []
                message = choices[0].get("message", {}) if choices and isinstance(choices[0], Mapping) else {}
                answer = str(message.get("content") or result.data.get("answer") or "Agent 未返回文本。").strip()
            elif result.ok:
                answer = str(result.data or "Agent 未返回文本。")
            else:
                answer = result.error
        except ValueError as exc:
            answer = str(exc)
    st.session_state.messages.append({"role": "assistant", "content": answer})
    with st.chat_message("assistant"):
        st.markdown(answer)


def load_files(cursor: Optional[str] = None) -> None:
    result = api_request(
        st.session_state.api_base,
        st.session_state.api_token,
        "GET",
        "/files",
        params={"cursor": cursor} if cursor else None,
    )
    if result.ok and isinstance(result.data, Mapping):
        objects = [
            item for item in result.data.get("objects", [])
            if isinstance(item, Mapping) and str(item.get("key", "")).startswith(UPLOAD_PREFIX)
        ]
        st.session_state.files_page = {**dict(result.data), "objects": objects, "active_cursor": cursor}
    else:
        st.error(result.error)


def render_files() -> None:
    st.subheader("文件")
    st.caption("文件存储在 R2 的 `uploads/` 路径下。")
    if not require_token():
        return
    uploads = st.file_uploader("选择文件（可多选）", accept_multiple_files=True, key="file_uploads")
    if uploads and st.button("上传所选文件", type="primary", use_container_width=True):
        failures = []
        for uploaded in uploads:
            file_bytes = uploaded.getvalue()
            key = make_upload_key(uploaded.name)
            result = api_request(
                st.session_state.api_base,
                st.session_state.api_token,
                "PUT",
                f"/files/{quote(key, safe='/')}",
                content=file_bytes,
                content_type=uploaded.type or "application/octet-stream",
            )
            if not result.ok:
                failures.append(f"{safe_filename(uploaded.name)}：{result.error}")
        if failures:
            st.error("\n".join(failures))
        else:
            st.success(f"已上传 {len(uploads)} 个文件。")
            st.session_state.files_page = None

    refresh, previous, next_page = st.columns(3)
    with refresh:
        if st.button("刷新列表", use_container_width=True):
            st.session_state.file_cursors = []
            load_files()
    page = st.session_state.files_page
    with previous:
        if st.button("上一页", disabled=not st.session_state.file_cursors, use_container_width=True):
            target = st.session_state.file_cursors.pop()
            load_files(target)
    with next_page:
        can_next = bool(page and page.get("truncated") and page.get("cursor"))
        if st.button("下一页", disabled=not can_next, use_container_width=True):
            st.session_state.file_cursors.append(page.get("active_cursor"))
            load_files(page.get("cursor"))

    if page is None:
        st.info("点击“刷新列表”读取文件。列表结果会保留在当前会话，避免页面刷新重复请求。")
        return
    objects = page.get("objects", [])
    if not objects:
        st.info("当前页没有 `uploads/` 文件。")
    for item in objects:
        key = str(item.get("key", ""))
        name = key.removeprefix(UPLOAD_PREFIX)
        with st.expander(f"{name} · {format_bytes(item.get('size'))}"):
            st.caption(f"上传时间：{format_time(item.get('uploaded'))}\n\n路径：`{key}`")
            get_col, download_col, delete_col = st.columns(3)
            with get_col:
                if st.button("准备下载", key=f"get-{key}", use_container_width=True):
                    download = api_request(
                        st.session_state.api_base,
                        st.session_state.api_token,
                        "GET",
                        f"/files/{quote(key, safe='/')}",
                        expect_bytes=True,
                    )
                    if download.ok:
                        st.session_state.file_downloads[key] = download.data
                    else:
                        st.error(download.error)
            with download_col:
                if key in st.session_state.file_downloads:
                    st.download_button(
                        "下载文件",
                        data=st.session_state.file_downloads[key],
                        file_name=safe_filename(name),
                        key=f"download-{key}",
                        use_container_width=True,
                    )
            with delete_col:
                if st.button("删除", key=f"delete-{key}", type="secondary", use_container_width=True):
                    result = api_request(
                        st.session_state.api_base,
                        st.session_state.api_token,
                        "DELETE",
                        f"/files/{quote(key, safe='/')}",
                    )
                    if result.ok:
                        st.session_state.files_page = None
                        st.session_state.file_downloads.pop(key, None)
                        st.success("文件已删除。")
                    else:
                        st.error(result.error)


def load_tasks() -> None:
    result = api_request(st.session_state.api_base, st.session_state.api_token, "GET", "/tasks")
    if result.ok and isinstance(result.data, list):
        st.session_state.tasks = result.data
    else:
        st.error(result.error)


def task_request_with_legacy_fallback(method: str, path: str, payload: Mapping[str, Any]) -> ApiResult:
    """优先使用带资源 ID 的新契约，兼容当前 /tasks PATCH 契约。"""
    result = api_request(st.session_state.api_base, st.session_state.api_token, method, path, json_body=payload)
    if result.status_code not in {404, 405}:
        return result
    return api_request(st.session_state.api_base, st.session_state.api_token, "PATCH", "/tasks", json_body=payload)


def render_tasks() -> None:
    st.subheader("任务")
    if not require_token():
        return
    with st.form("create_task", clear_on_submit=True):
        title = st.text_input("标题")
        description = st.text_area("描述（可选）")
        due_at = st.text_input("截止时间（ISO 8601，可选）", placeholder="2026-08-18T18:00:00+08:00")
        idempotency_key = st.text_input("幂等键（可选）", value=str(uuid.uuid4()))
        create = st.form_submit_button("创建任务", type="primary", use_container_width=True)
    if create:
        try:
            payload = build_task_payload(title, description, due_at or None, idempotency_key or None)
            result = api_request(st.session_state.api_base, st.session_state.api_token, "POST", "/tasks", json_body=payload)
            if result.ok:
                st.success("任务已创建。")
                st.session_state.tasks = None
            else:
                st.error(result.error)
        except ValueError as exc:
            st.error(str(exc))
    if st.button("刷新任务", use_container_width=True):
        load_tasks()
    if st.session_state.tasks is None:
        st.info("点击“刷新任务”读取任务；数据会留在当前会话以避免重复读取。")
        return
    if not st.session_state.tasks:
        st.info("暂无任务。")
        return
    for task in st.session_state.tasks:
        if not isinstance(task, Mapping):
            continue
        task_id = str(task.get("id", ""))
        status = str(task.get("status", "pending"))
        version = task.get("version", task.get("updated_at"))
        with st.expander(f"{task.get('title', '未命名任务')} · {status}"):
            st.write(task.get("description") or "无描述")
            st.caption(f"截止：{format_time(task.get('due_at'))} · 更新：{format_time(task.get('updated_at'))}")
            action_col, status_col = st.columns(2)
            with action_col:
                if st.button("认领任务", key=f"claim-{task_id}", use_container_width=True):
                    claim_payload = {"id": task_id, "status": "running", "version": version}
                    result = task_request_with_legacy_fallback("POST", f"/tasks/{quote(task_id)}/claim", claim_payload)
                    if result.ok:
                        st.success("任务已认领。")
                        st.session_state.tasks = None
                    else:
                        st.error(result.error)
            with status_col:
                target_status = st.selectbox(
                    "更新状态",
                    TASK_STATUSES,
                    index=TASK_STATUSES.index(status) if status in TASK_STATUSES else 0,
                    key=f"status-{task_id}",
                )
                if st.button("提交状态", key=f"update-{task_id}", use_container_width=True):
                    try:
                        payload = build_task_update_payload(task_id, target_status, version)
                        result = task_request_with_legacy_fallback("PATCH", f"/tasks/{quote(task_id)}", payload)
                        if result.ok:
                            st.success("任务状态已更新。")
                            st.session_state.tasks = None
                        else:
                            st.error(result.error)
                    except ValueError as exc:
                        st.error(str(exc))


def render_knowledge() -> None:
    st.subheader("知识库")
    st.caption("提交文本，或上传 TXT、MD、PDF 后在浏览器端提取文本。")
    if not require_token():
        return
    with st.form("add_knowledge", clear_on_submit=True):
        text = st.text_area("知识文本", height=180)
        document = st.file_uploader("或选择 TXT / MD / PDF", type=sorted(ALLOWED_UPLOAD_EXTENSIONS), key="knowledge_document")
        add = st.form_submit_button("写入知识库", type="primary", use_container_width=True)
    if add:
        try:
            source_name = "manual-input"
            if document is not None:
                source_name = document.name
                content = extract_knowledge_text(document.name, document.getvalue())
            else:
                content = text
            payload = build_knowledge_payload(content, source_name)
            result = api_request(st.session_state.api_base, st.session_state.api_token, "POST", "/knowledge", json_body=payload)
            if result.ok:
                st.success("知识已写入。")
            else:
                st.error(result.error)
        except (ValueError, RuntimeError) as exc:
            st.error(str(exc))

    with st.form("search_knowledge"):
        query = st.text_input("搜索知识")
        search = st.form_submit_button("搜索", use_container_width=True)
    if search:
        if not query.strip():
            st.warning("请输入搜索词。")
        else:
            result = api_request(
                st.session_state.api_base,
                st.session_state.api_token,
                "GET",
                "/knowledge/search",
                params={"q": query.strip()},
            )
            if result.ok:
                st.session_state.knowledge_results = result.data if isinstance(result.data, list) else []
            else:
                st.error(result.error)
    if st.session_state.knowledge_results is None:
        st.info("搜索结果会保留在当前会话，避免页面重跑重复远程读取。")
        return
    if not st.session_state.knowledge_results:
        st.info("没有匹配的知识。")
    for entry in st.session_state.knowledge_results:
        if not isinstance(entry, Mapping):
            continue
        entry_id = str(entry.get("id", ""))
        title = entry.get("metadata", {}).get("source", "知识条目") if isinstance(entry.get("metadata"), Mapping) else "知识条目"
        with st.expander(f"{title} · {entry_id[:8]}"):
            st.write(entry.get("content", ""))
            if entry.get("similarity") is not None:
                st.caption(f"相似度：{entry.get('similarity')}")
            if st.button("删除此知识", key=f"knowledge-delete-{entry_id}", type="secondary"):
                result = api_request(
                    st.session_state.api_base,
                    st.session_state.api_token,
                    "DELETE",
                    f"/knowledge/{quote(entry_id)}",
                )
                if result.ok:
                    st.session_state.knowledge_results = [
                        item for item in st.session_state.knowledge_results if item.get("id") != entry_id
                    ]
                    st.success("知识已删除。")
                else:
                    st.error(result.error)


def main() -> None:
    if st is None:
        raise RuntimeError("请先安装 requirements.txt 中的依赖。")
    st.set_page_config(page_title="Wangdada Agent 控制台", page_icon="🤖", layout="centered")
    ensure_state()
    render_sidebar()
    st.title("Wangdada Agent 控制台")
    st.caption("对话、文件、任务与知识库都在一个适合手机使用的单用户工作台。")
    chat_tab, files_tab, tasks_tab, knowledge_tab = st.tabs(["对话", "文件", "任务", "知识库"])
    with chat_tab:
        render_chat()
    with files_tab:
        render_files()
    with tasks_tab:
        render_tasks()
    with knowledge_tab:
        render_knowledge()


if __name__ == "__main__":
    main()
