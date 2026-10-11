"""Execute the workflow's actual Python step with a network-isolated response."""

import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import urllib.error
import urllib.request
from unittest.mock import patch


spec = json.load(sys.stdin)
calls = []
output = io.StringIO()
code = 0


class Reply:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, limit):
        assert limit == 65537, "Response reading must remain bounded"
        return spec.get("response", "{}").encode("utf-8")[:limit]


class Opener:
    def open(self, request, timeout):
        calls.append({"url": request.full_url, "method": request.method,
                      "headers": dict(request.header_items()),
                      "body": request.data.decode("utf-8"), "timeout": timeout})
        scenario = spec.get("scenario")
        if scenario == "timeout":
            raise TimeoutError("Private upstream diagnostic")
        if scenario == "redirect":
            raise urllib.error.HTTPError(request.full_url, 307, "Redirect", {}, None)
        if scenario == "http":
            raise urllib.error.HTTPError(request.full_url, 503, "Private diagnostic", {}, None)
        return Reply()


def build_opener(*handlers):
    assert len(handlers) == 1, "Use the no-redirect handler"
    handler = handlers[0]() if isinstance(handlers[0], type) else handlers[0]
    assert isinstance(handler, urllib.request.HTTPRedirectHandler)
    assert handler.redirect_request(None, None, 307, "Redirect", {},
                                    "https://untrusted.invalid/") is None
    return Opener()


with tempfile.TemporaryDirectory(prefix="bellhaven-workflow-test-") as folder:
    summary = Path(folder) / "summary.md"
    env = {**spec.get("env", {}), "GITHUB_STEP_SUMMARY": str(summary)}
    try:
        with patch.dict(os.environ, env, clear=True), \
                patch("urllib.request.build_opener", side_effect=build_opener), \
                patch("socket.create_connection", side_effect=AssertionError("Network forbidden")), \
                contextlib.redirect_stdout(output):
            exec(compile(spec["script"], "daily-reconciliation.yml", "exec"), {})
    except SystemExit as error:
        code = error.code
    result = {"code": code, "output": output.getvalue(), "calls": calls,
              "summary": summary.read_text(encoding="utf-8") if summary.exists() else ""}
json.dump(result, sys.stdout)
