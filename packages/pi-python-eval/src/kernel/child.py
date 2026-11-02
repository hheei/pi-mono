from __future__ import annotations

import ast
import builtins
import codecs
import io
import json
import os
import sys
import traceback
import threading
import time
import uuid
from typing import Any

MAX_EVAL_FRAME_CHARS = 1_048_576 + 65_536
_THIS_FILE = os.path.abspath(__file__)
_STATE_LIST_LIMIT = 12
_CELL_ID = ""
_TOOL_SEQ = 0
_NS: dict[str, Any] = {"__name__": "__main__", "__builtins__": builtins}
_RAW_STDERR = sys.__stderr__
_CAPTURE_READ_FD: int | None
_CAPTURE_TOKEN_FD: int | None
try:
    _FRAME_FD = os.dup(sys.__stdout__.fileno())
    _FRAME_OUT = os.fdopen(_FRAME_FD, "w", encoding="utf-8", errors="backslashreplace")
    _CAPTURE_READ_FD, _capture_write_fd = os.pipe()
    _CAPTURE_TOKEN_FD = os.dup(_capture_write_fd)
    os.dup2(_capture_write_fd, sys.__stdout__.fileno())
    os.close(_capture_write_fd)
except (AttributeError, OSError, ValueError):
    _FRAME_OUT = sys.__stdout__
    _CAPTURE_READ_FD = None
    _CAPTURE_TOKEN_FD = None
_SESSION_CWD = os.getcwd()
if _SESSION_CWD not in sys.path:
    sys.path.insert(0, _SESSION_CWD)

_INJECTED_NAMES = frozenset(
    {
        "__name__",
        "__builtins__",
        "print",
        "display",
        "cwd",
        "names",
        "tools",
        "EvalToolError",
    }
)


def send(message: dict[str, Any]) -> None:
    line = json.dumps(message, default=_json_default, ensure_ascii=False)
    if len(line) > MAX_EVAL_FRAME_CHARS:
        line = json.dumps(
            {
                "type": "done",
                "cellId": message.get("cellId") or _CELL_ID,
                "ok": False,
                "error": "Eval kernel frame exceeded 1 MiB.",
            },
            ensure_ascii=False,
        )
    _FRAME_OUT.write(line)
    _FRAME_OUT.write("\n")
    _FRAME_OUT.flush()


_DRAIN_LOCK = threading.Lock()
_DRAIN_WATCH: tuple[bytes, threading.Event] | None = None
_DRAIN_BUFFER = b""
_DRAIN_DECODER = codecs.getincrementaldecoder("utf-8")("replace")
_DRAIN_THREAD: threading.Thread | None = None


def _emit_captured(text: str) -> None:
    if not text:
        return
    if _CELL_ID:
        send({"type": "text", "cellId": _CELL_ID, "text": text})
    else:
        send({"type": "background", "text": text})


def _flush_captured_decoder() -> None:
    global _DRAIN_DECODER
    text = _DRAIN_DECODER.decode(b"", final=True)
    _DRAIN_DECODER = codecs.getincrementaldecoder("utf-8")("replace")
    _emit_captured(text)


def _feed_captured(chunk: bytes) -> None:
    global _DRAIN_BUFFER
    data = _DRAIN_BUFFER + chunk
    _DRAIN_BUFFER = b""
    with _DRAIN_LOCK:
        watch = _DRAIN_WATCH
    if watch is None:
        _emit_captured(_DRAIN_DECODER.decode(data))
        return
    token, seen = watch
    while True:
        index = data.find(token)
        if index < 0:
            break
        _emit_captured(_DRAIN_DECODER.decode(data[:index]))
        _flush_captured_decoder()
        seen.set()
        data = data[index + len(token) :]
    hold = 0
    for size in range(min(len(data), len(token) - 1), 0, -1):
        if data.endswith(token[:size]):
            hold = size
            break
    if hold:
        _DRAIN_BUFFER = data[len(data) - hold :]
        data = data[: len(data) - hold]
    _emit_captured(_DRAIN_DECODER.decode(data))


def _drain_captured_stdout() -> None:
    if _CAPTURE_READ_FD is None:
        return
    while True:
        try:
            chunk = os.read(_CAPTURE_READ_FD, 65536)
        except OSError:
            return
        if not chunk:
            return
        _feed_captured(chunk)


def _start_capture_drain() -> None:
    global _DRAIN_THREAD
    if _CAPTURE_READ_FD is None:
        return
    thread = threading.Thread(target=_drain_captured_stdout, name="eval-fd1-capture", daemon=True)
    _DRAIN_THREAD = thread
    thread.start()


def _flush_captured_output() -> None:
    global _DRAIN_WATCH
    if _CAPTURE_READ_FD is None or _CAPTURE_TOKEN_FD is None:
        return
    token = b"\xff<drain:" + uuid.uuid4().hex.encode() + b">\xff"
    seen = threading.Event()
    with _DRAIN_LOCK:
        _DRAIN_WATCH = (token, seen)
    try:
        os.write(_CAPTURE_TOKEN_FD, token)
        while not seen.wait(0.1):
            thread = _DRAIN_THREAD
            if thread is None or not thread.is_alive():
                return
    except OSError:
        return
    finally:
        with _DRAIN_LOCK:
            _DRAIN_WATCH = None


def _json_default(value: Any) -> str:
    return repr(value)


def clone_value(value: Any) -> Any:
    if value is None:
        return None
    try:
        return json.loads(json.dumps(value, default=_json_default))
    except TypeError:
        return repr(value)


class _StdStream(io.TextIOBase):
    def write(self, data: Any) -> int:  # type: ignore[override]
        text = data if isinstance(data, str) else str(data)
        if text:
            if _CELL_ID:
                send({"type": "text", "cellId": _CELL_ID, "text": text})
            else:
                send({"type": "background", "text": text})
        return len(text)

    def flush(self) -> None:
        return None

    def isatty(self) -> bool:
        return False


def _reset_session_cwd() -> None:
    os.chdir(_SESSION_CWD)
    try:
        sys.path.remove(_SESSION_CWD)
    except ValueError:
        pass
    sys.path.insert(0, _SESSION_CWD)


def _start_parent_watchdog() -> None:
    if os.name != "posix":
        return
    original_ppid = os.getppid()
    if original_ppid <= 1:
        return

    def watch() -> None:
        while True:
            try:
                if os.getppid() != original_ppid:
                    os._exit(0)
            except Exception:
                return
            time.sleep(10)

    threading.Thread(target=watch, name="eval-parent-watchdog", daemon=True).start()


def _print(*args: Any, **kwargs: Any) -> None:
    file = kwargs.get("file")
    if file not in (None, sys.stdout):
        return builtins.print(*args, **kwargs)
    kwargs.pop("file", None)
    buffer = io.StringIO()
    builtins.print(*args, file=buffer, **kwargs)
    text = buffer.getvalue()
    if not text:
        return
    if _CELL_ID:
        send({"type": "text", "cellId": _CELL_ID, "text": text})
    else:
        send({"type": "background", "text": text})


def _display(value: Any) -> None:
    if not _CELL_ID:
        return
    send({"type": "display", "cellId": _CELL_ID, "value": clone_value(value)})


def _cwd() -> str:
    return os.getcwd()


def _user_names() -> set[str]:
    return {
        name
        for name in _NS
        if name not in _INJECTED_NAMES and not name.startswith("__")
    }


def _names() -> list[str]:
    return sorted(_user_names())


def _imported_names(code: str) -> list[str]:
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return []
    names: list[str] = []
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.append(alias.asname or alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name != "*":
                    names.append(alias.asname or alias.name)
    return names


def _state_payload(before: set[str], imported: list[str]) -> dict[str, Any]:
    current = _user_names()
    added = sorted(current - before)
    redundant = sorted({name for name in imported if name in before})
    return {
        "names": len(current),
        "addedCount": len(added),
        "added": added[:_STATE_LIST_LIMIT],
        "redundant": redundant[:_STATE_LIST_LIMIT],
    }


class EvalToolError(Exception):
    def __init__(self, message: str, trace: Any = None) -> None:
        super().__init__(message)
        self.name = "EvalToolError"
        self.trace = trace


def _read_message() -> dict[str, Any]:
    line = sys.stdin.readline(MAX_EVAL_FRAME_CHARS + 1)
    if line == "":
        raise EOFError("Eval host closed the kernel.")
    if len(line) > MAX_EVAL_FRAME_CHARS:
        raise SystemExit("Eval kernel frame exceeded 1 MiB.")
    return json.loads(line)


def _call_tool(name: str, args: Any) -> Any:
    global _TOOL_SEQ
    _TOOL_SEQ += 1
    request_id = f"{_CELL_ID}:{_TOOL_SEQ}"
    send(
        {
            "type": "toolCall",
            "cellId": _CELL_ID,
            "id": request_id,
            "name": name,
            "args": clone_value(args),
        }
    )
    while True:
        message = _read_message()
        if message.get("type") == "shutdown":
            raise SystemExit(0)
        if message.get("type") != "toolResult" or message.get("id") != request_id:
            continue
        if message.get("ok"):
            return message.get("value")
        error = message.get("error") or {}
        raise EvalToolError(
            str(error.get("message") or f"{name} failed"),
            error.get("trace"),
        )


class _ToolMethod:
    def __init__(self, name: str) -> None:
        self._name = name

    def __call__(self, args: Any = None, **kwargs: Any) -> Any:
        if args is not None and kwargs:
            raise TypeError("tool methods accept a dict or keyword arguments, not both")
        if args is None:
            payload: Any = kwargs
        elif isinstance(args, dict):
            payload = args
        else:
            raise TypeError("tool methods expect a dict of arguments")
        return _call_tool(self._name, payload)

    # ponytail: atomic proxy singleton; copy/deepcopy returns self
    def __copy__(self) -> Any:
        return self

    def __deepcopy__(self, memo: Any) -> Any:
        return self


class _ToolProxy:
    def __getattr__(self, name: str) -> _ToolMethod:
        if name.startswith("_"):
            raise AttributeError(f"'tools' object has no attribute {name!r}")
        return _ToolMethod(name)

    # ponytail: atomic proxy singleton; copy/deepcopy returns self
    def __copy__(self) -> Any:
        return self

    def __deepcopy__(self, memo: Any) -> Any:
        return self


def _compile_source(code: str) -> tuple[Any, bool]:
    try:
        tree = ast.parse(code, filename="<eval>")
        if not tree.body:
            return compile(tree, "<eval>", "exec"), False
        last = tree.body[-1]
        if not isinstance(last, ast.Expr):
            return compile(tree, "<eval>", "exec"), False
        tree.body[-1] = ast.Assign(
            targets=[ast.Name(id="__eval_final__", ctx=ast.Store())],
            value=last.value,
        )
        ast.fix_missing_locations(tree)
        return compile(tree, "<eval>", "exec"), True
    except SyntaxError as error:
        error.msg += "\nCell did not run; no assignments or tool calls in this cell took effect. Fix and re-run the entire cell."
        if "'await' outside function" in error.msg:
            error.msg += "\nNested tools are synchronous: use result = tools.name(...) without await."
        raise


def _filter_traceback_exception(te: traceback.TracebackException) -> traceback.TracebackException:
    te.stack = traceback.StackSummary(
        [f for f in te.stack if os.path.abspath(f.filename) != _THIS_FILE]
    )
    if te.__cause__ is not None:
        _filter_traceback_exception(te.__cause__)
    if te.__context__ is not None:
        _filter_traceback_exception(te.__context__)
    if hasattr(te, "exceptions") and te.exceptions:
        for exc in te.exceptions:
            _filter_traceback_exception(exc)
    return te


def _format_exception(error: BaseException) -> str:
    try:
        te = traceback.TracebackException.from_exception(error)
        _filter_traceback_exception(te)
        formatted = "".join(te.format())
        if formatted.strip():
            return formatted
    except Exception:
        pass
    return traceback.format_exc() or str(error) or type(error).__name__


def _execute(cell_id: str, code: str) -> None:
    global _CELL_ID
    _reset_session_cwd()
    _CELL_ID = cell_id
    _NS["print"] = _print
    _NS["display"] = _display
    _NS["cwd"] = _cwd
    _NS["names"] = _names
    _NS["tools"] = _ToolProxy()
    _NS["EvalToolError"] = EvalToolError
    _NS.pop("__eval_final__", None)
    before = _user_names()
    imported = _imported_names(code)
    try:
        compiled, has_value = _compile_source(code)
        exec(compiled, _NS, _NS)
        value = _NS.pop("__eval_final__", None) if has_value else None
        _flush_captured_output()
        done: dict[str, Any] = {
            "type": "done",
            "cellId": cell_id,
            "ok": True,
            "state": _state_payload(before, imported),
        }
        # A None value carries no information for the host and would render a bare `null`
        # row on every print/assignment cell, so omit it the way Python's own displayhook
        # suppresses None.
        if value is not None:
            done["value"] = clone_value(value)
        send(done)
    except KeyboardInterrupt:
        _flush_captured_output()
        send(
            {
                "type": "done",
                "cellId": cell_id,
                "ok": False,
                "error": "Eval was aborted.",
                "state": _state_payload(before, imported),
            }
        )
    except Exception as error:
        _flush_captured_output()
        message = _format_exception(error)
        send(
            {
                "type": "done",
                "cellId": cell_id,
                "ok": False,
                "error": message[:4000],
                "state": _state_payload(before, imported),
            }
        )
    finally:
        _CELL_ID = ""


sys.stdout = _StdStream()
sys.stderr = _StdStream()
_start_parent_watchdog()
_start_capture_drain()
send({"type": "ready"})

while True:
    try:
        incoming = _read_message()
    except EOFError:
        break
    except KeyboardInterrupt:
        continue
    kind = incoming.get("type")
    if kind == "shutdown":
        break
    if kind == "execute":
        _execute(str(incoming.get("cellId") or ""), str(incoming.get("code") or ""))
