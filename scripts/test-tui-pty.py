#!/usr/bin/env python3
"""Built CLI/TUI smoke in a PTY against a fake HTTP server.

Requires Python 3 and pnpm build. No agents, Herdr, providers, secrets,
operator panes or user configuration are accessed. The server owns all Herdr
IO, so the fixture only records which session routes the TUI calls.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")
if NODE:
    NODE = subprocess.check_output([NODE, "-p", "process.execPath"], text=True).strip()
assert NODE, "Node is required"
CLI = str(REPO / "packages/cli/dist/index.js")
assert Path(CLI).exists(), "Run pnpm build first"
NOW = datetime.now(timezone.utc).isoformat()
WORK_ID, NEW_ID, JIRA_WORK_ID = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
ISSUE = dict(id="42", key="PROJ-42", title="Fixture Jira work", url="https://jira.invalid/42",
             status="To Do", issueType="Task", updatedAt=NOW, descriptionText="Full Jira description")
REPOSITORIES = [dict(id=f"github:{i}", provider="github", externalId=str(i), name=name,
                    fullName=f"org/{name}", cloneUrl=f"https://github.invalid/org/{name}.git",
                    defaultBranch="main", isArchived=False, topics=[topic], lastSyncedAt=NOW)
                for i, name, topic in [(1, "sync", "infra"), (2, "client", "examplecom")]]
JIRA_PROMPT = "Refine PROJ-42: Fixture Jira work\n\nFull Jira description\n"
PROMPT = "Fixture task\nwith Unicode: 日報 e\u0301\n\n  "
requests, output = [], bytearray()
created, received_prompt = False, None
opened = []
jira_launch = None
master = pid = status = server = None


def work(work_id):
    return dict(id=work_id, title="Fixture work" if work_id == WORK_ID else "Fixture task",
                state="active", notes="", createdAt=NOW, updatedAt=NOW,
                startedAt=NOW, completedAt=None)


def summary(work_id):
    return dict(work(work_id), sessionCount=1, repositoryCount=0,
                trackerIssueKeys=[], pullRequestRefs=[])


def details(work_id):
    payload = dict(toolId="pi", agentName="ll-fixture", title="Fixture agent session", cwd=str(REPO),
                   status="ended", agentState="ended", nativeSessionId=None,
                   nativeSessionPath="/fixture/session.jsonl",
                   terminalRef=dict(workspaceId="w1", paneId="w1:p1"),
                   createdAt=NOW, updatedAt=NOW, metadata={})
    meta = dict(id="fixture-session", workItemId=work_id, metaType="session",
                provider="pi", externalId="ll-fixture", payloadJson=json.dumps(payload),
                createdAt=NOW, updatedAt=NOW)
    return dict(workItem=work(work_id), metas=[meta])


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, body, code=200):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        requests.append(("GET", self.path, None))
        if self.path == "/dashboard":
            active = [summary(WORK_ID)]
            if created:
                active.insert(0, summary(NEW_ID))
            return self.reply(dict(activeWorkItems=active, pendingJiraIssues=[ISSUE],
                recent=dict(since="2026-10-06T00:00:00.000Z", workItems=[], sessionCount=0,
                               completedCount=0, cancelledCount=0, activityCount=0),
                settings=dict(defaultAgent="pi", sidebarSide="right", repositoryTopics=["infra", "examplecom"]),
                freshness=dict(jiraFetchedAt=NOW, githubFetchedAt=NOW,
                               jiraStale=False, githubStale=False)))
        if self.path == "/work-items":
            return self.reply([work(WORK_ID)] + ([work(NEW_ID)] if created else []))
        if self.path.startswith("/work-items/"):
            return self.reply(details(self.path.split("/")[2]))
        if self.path == "/jira/issues":
            return self.reply([ISSUE])
        if self.path == "/repos":
            return self.reply(REPOSITORIES)
        if self.path == "/prompts":
            return self.reply([dict(id="refine", title="Refine", content="Refine {{title}}",
                                   builtIn=True, overridden=False)])
        if self.path == "/status":
            return self.reply(dict(ok=True, repoCount=0, workItemCount=1, lastRepoSyncAt=NOW))
        return self.reply(dict(error="Unknown fixture endpoint"), 404)

    def do_POST(self):
        global created, received_prompt, jira_launch
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        requests.append(("POST", self.path, body))
        work_id = self.path.split("/")[2]
        if self.path.endswith("/open"):
            opened.append(work_id)
            return self.reply(dict(action="continued", details=details(work_id)))
        if self.path == "/prompts/render":
            assert body["promptId"] == "refine"
            assert body["sources"][0]["payload"]["descriptionText"] == ISSUE["descriptionText"]
            return self.reply(dict(promptId="refine", content=JIRA_PROMPT))
        if self.path == "/work-items/quick-start" and body.get("jiraIssueId"):
            uuid.UUID(body["requestId"])
            jira_launch = body
            return self.reply(dict(details=details(JIRA_WORK_ID), launch=dict(ok=True, error=None, phase="started"),
                                   operation=dict(requestId=body["requestId"], status="completed")))
        if self.path == "/work-items/quick-start":
            received_prompt = body["prompt"]
            uuid.UUID(body["requestId"])
            assert not body.get("repoIds")
            created = True
            return self.reply(dict(details=details(NEW_ID), launch=dict(ok=True, error=None, phase="started"),
                                   operation=dict(requestId=body["requestId"], status="completed")))
        return self.reply(dict(error="Unexpected fixture mutation"), 400)


def pump(seconds=0.1):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        readable, _, _ = select.select([master], [], [], min(0.05, max(0, end - time.monotonic())))
        if readable:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            output.extend(data)


def until(predicate, message, timeout=7):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        pump()
        if predicate():
            return
    raise AssertionError(message + "\nTerminal tail: " + output[-5000:].decode(errors="replace"))


def send(data):
    os.write(master, data)
    pump(0.2)


def resize(cols, rows):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.kill(pid, signal.SIGWINCH)
    pump(0.15)


with tempfile.TemporaryDirectory(prefix="lovelace-ui-pty-") as temporary:
    env = dict(os.environ)
    for key in list(env):
        if key.startswith("HERDR_") or key in ("TMUX", "TMUX_PANE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "BASH_ENV", "ENV"):
            del env[key]
    env.update(HOME=temporary, ZDOTDIR=temporary, SHELL="/bin/sh",
               LOVELACE_ROOT=temporary, LOVELACE_CONFIG=os.path.join(temporary, "config.jsonc"), TERM="xterm-256color")
    try:
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        env.update(LOVELACE_PORT=str(server.server_port), LOVELACE_HOST="127.0.0.1")
        no_args = subprocess.run([NODE, CLI], env=env, capture_output=True, text=True, timeout=4)
        assert no_args.returncode == 0 and "lovelace <command>" in no_args.stdout, no_args
        assert requests == [], "No-argument CLI performed an HTTP request"
        cli_status = subprocess.run([NODE, CLI, "status"], env=env, capture_output=True, text=True, timeout=4)
        assert cli_status.returncode == 0 and json.loads(cli_status.stdout)["ok"], cli_status
        pid, master = pty.fork()
        if pid == 0:
            os.execve(NODE, [NODE, CLI, "tui"], env)
        resize(120, 32)
        until(lambda: b"Recent work" in output and b"Fixture work" in output,
              "Explicit TUI did not render dashboard/sidebar")
        for cols, rows in [(80, 24), (50, 12), (120, 32)]:
            resize(cols, rows)
        # SGR mouse, 1-based: drag the divider (col 92 at 120 cols) left, then
        # click sidebar rows only reachable at the resized position.
        mouse = lambda button, x, y, final=b"M": send(b"\x1b[<%d;%d;%d" % (button, x, y) + final)
        mouse(0, 92, 10)
        mouse(32, 60, 10)
        mouse(0, 60, 10, b"m")
        mouse(0, 70, 5)
        mouse(0, 70, 5, b"m")
        until(lambda: any(path == "/work-items/" + WORK_ID for _, path, _ in requests),
              "Clicking a resized sidebar row did not load details")
        mouse(0, 70, 2)
        mouse(0, 70, 2, b"m")
        for _ in range(2):  # double-click restores the responsive width
            mouse(0, 60, 10)
            mouse(0, 60, 10, b"m")
        requests.clear()
        send(b"\t")
        send(b"\x1b[B")
        send(b"\r")
        until(lambda: any(path == "/work-items/" + WORK_ID for _, path, _ in requests),
              "Sidebar did not load details")
        until(lambda: b"Fixture agent session" in output, "Sessions were not rendered")
        send(b"\r")
        until(lambda: opened == [WORK_ID], "Selecting a session did not ask the server to open it")
        until(lambda: b"Continued the conversation in Herdr" in output, "Continuation was not reported")
        assert b"y confirm" not in output, "Opening a session asked for confirmation"
        send(b"\x1b")
        send(b"\r")
        until(lambda: b"Start work" in output, "Jira details did not offer setup")
        send(b"\r")
        until(lambda: any(path == "/prompts" for _, path, _ in requests), "Prompt catalog not requested")
        until(lambda: b"[ ] sync" in output and b"editable preview" in output,
              "Single repository/prompt overlay not rendered")
        send(b"\x1b")
        send(b"\r")
        until(lambda: sum(path == "/prompts" for _, path, _ in requests) == 2,
              "Cancel did not preserve the underlying Jira page")
        send(b"\x01")  # Select all matching repositories
        send(b"\x15")  # Unselect all, including selections hidden by filters
        send(b" ")
        send(b"/")
        send(b"\x1b[200~client\x1b[201~")
        send(b"\r")
        send(b"t")
        send(b"\x15")  # replace configured topic defaults
        send(b"\x1b[200~examplecom\x1b[201~")
        send(b"\r")
        send(b" ")
        for cols, rows in [(50, 12), (80, 24), (120, 32)]:
            resize(cols, rows)
        send(b"\t")  # template selector, in the same modal
        send(b"\x1b[C")  # manual prompt
        send(b"\x1b[C")  # refine template
        until(lambda: sum(path == "/prompts/render" for _, path, _ in requests) >= 2,
              "Template selector did not render a preview")
        send(b"\t")  # large prompt editor
        send(b"\x1b[1;5F")
        send(b"\x1b[200~Edited final prompt.\x1b[201~")
        send(b"\r")  # newline, never an accidental launch
        assert jira_launch is None, "Enter in the modal editor launched work"
        send(b"  Preserve this newline.")
        send(b"\x13")  # explicit Ctrl+S start
        until(lambda: jira_launch is not None, "Jira selection did not launch")
        assert jira_launch["repoIds"] == ["github:1", "github:2"], jira_launch
        assert jira_launch["promptId"] == "refine", jira_launch
        assert jira_launch["prompt"] == JIRA_PROMPT + "Edited final prompt.\n  Preserve this newline.", jira_launch
        until(lambda: any(path == "/work-items/" + JIRA_WORK_ID for _, path, _ in requests),
              "Jira launch did not navigate to saved work")
        send(b"\x1b")
        send(b"n")
        send(b"\x1b[200~" + PROMPT.encode() + b"\x1b[201~")
        send(b"\r")
        until(lambda: any(path == "/work-items/" + NEW_ID for _, path, _ in requests),
              "Successful launch did not navigate to saved work")
        assert received_prompt == PROMPT, repr(received_prompt)
        assert opened == [WORK_ID], "Quick-start opened its session"
        send(b"q")
        end, waited = time.monotonic() + 4, 0
        while time.monotonic() < end:
            pump()
            waited, status = os.waitpid(pid, os.WNOHANG)
            if waited:
                break
        assert waited == pid, "Quit leaked a timer, poller or host client"
        pid = None
        assert os.waitstatus_to_exitcode(status) == 0, status
        print("PASS: noninteractive CLI help/JSON, explicit responsive TUI, mouse divider resize and row clicks, one-step session open without confirmation, single Jira repository/prompt overlay, cancel without navigation, multi-select across separate name/topic filters, exact edited prompt and multiline paste, quick-start without auto-open, clean quit")
    finally:
        if pid:
            try:
                os.killpg(pid, signal.SIGTERM)
                limit = time.monotonic() + 1
                while time.monotonic() < limit:
                    waited, _ = os.waitpid(pid, os.WNOHANG)
                    if waited:
                        break
                    time.sleep(0.05)
                else:
                    os.killpg(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
            except (ProcessLookupError, ChildProcessError):
                pass
        if master is not None:
            os.close(master)
        if server:
            server.shutdown()
            server.server_close()
