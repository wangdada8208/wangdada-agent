import json
import unittest

from streamlit_app import (
    SAFE_SESSION_RE,
    build_chat_payload,
    build_knowledge_payload,
    build_task_payload,
    build_task_update_payload,
    make_upload_key,
    parse_api_response,
    safe_filename,
)


class StreamlitHelperTests(unittest.TestCase):
    def test_safe_filename_removes_path_traversal_and_controls(self):
        self.assertEqual(safe_filename("../../private\\report\x00.md"), "report.md")
        self.assertEqual(safe_filename("..."), "file")
        self.assertEqual(safe_filename("  agent notes.md  "), "agent notes.md")

    def test_upload_key_is_scoped_to_uploads_and_never_preserves_a_path(self):
        key = make_upload_key("../../secret.txt", unique_id="fixed")
        self.assertEqual(key, "uploads/fixed-secret.txt")
        self.assertNotIn("..", key)

    def test_chat_payload_builds_and_keeps_the_request_id(self):
        payload = build_chat_payload(" hello ", "named-session", "req-123")
        self.assertEqual(payload, {"message": "hello", "session_id": "named-session", "request_id": "req-123"})
        self.assertTrue(SAFE_SESSION_RE.fullmatch(payload["session_id"]))

    def test_chat_payload_rejects_unsafe_session_id(self):
        with self.assertRaises(ValueError):
            build_chat_payload("hello", "../unsafe")

    def test_json_and_text_responses_are_parsed_safely(self):
        ok = parse_api_response(201, json.dumps({"id": "abc"}), "application/json")
        self.assertTrue(ok.ok)
        self.assertEqual(ok.data, {"id": "abc"})

        failed = parse_api_response(409, '{"error":"version_conflict"}', "application/json")
        self.assertFalse(failed.ok)
        self.assertIn("HTTP 409", failed.error)
        self.assertIn("version_conflict", failed.error)

        text = parse_api_response(502, "bad gateway", "text/plain")
        self.assertEqual(text.data, "bad gateway")
        self.assertIn("bad gateway", text.error)

    def test_task_creation_and_versioned_update_payloads(self):
        task = build_task_payload(" Deploy ", "  production ", "2026-08-18T18:00:00+08:00", "once-1")
        self.assertEqual(task["title"], "Deploy")
        self.assertEqual(task["idempotency_key"], "once-1")
        update = build_task_update_payload("task-123", "completed", 7)
        self.assertEqual(update, {"id": "task-123", "status": "completed", "version": 7})
        with self.assertRaises(ValueError):
            build_task_update_payload("task-123", "completed", None)

    def test_knowledge_payload_uses_safe_source_metadata(self):
        payload = build_knowledge_payload(" useful text ", "../../notes.md")
        self.assertEqual(payload["content"], "useful text")
        self.assertEqual(payload["metadata"], {"source": "notes.md"})


if __name__ == "__main__":
    unittest.main()
