"""The agents service (`python -m app.runner`), SPEC step 25: runs every built-in agent made
on the Agents screen, one thread each, until it is deleted.

Each agent signs in to the agent API at HUB_URL (http://api:8000 in the stack) with its
runner token, sends its manifest (its kind's, naming the job it was added for), then asks
for work every RUNNER_POLL_SECONDS (30) like any agent.
"""

import logging
import os
import signal
import threading
from types import FrameType

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app import logs
from app.builtin import KINDS, Kind, runner_token
from app.builtin.client import HubClient
from app.config import get_settings
from app.db.models import Agent, Task
from app.db.session import get_engine

log = logging.getLogger("runner")

LOOK_SECONDS = 5.0  # how often the agents made or deleted on the Agents screen are looked up


def run_agent(hub: HubClient, kind: Kind, task: str, stop: threading.Event, poll: float) -> None:
    """One built-in agent: its manifest, then its runs, until `stop` is set."""
    manifest = kind.manifest | {"task": task}
    while not stop.is_set():
        try:
            status, reply = hub.call("PUT", "/manifest", manifest)
        except OSError:
            status, reply = 0, "the Hub isn't answering yet"
        if status == 200:
            break
        log.warning("manifest of %s not taken (%s): %s", hub.token.split(".")[0], status, reply)
        stop.wait(poll)
    while not stop.is_set():
        try:
            status, job = hub.call("GET", "/next-run")
            if status == 200:
                kind.run(hub, job)
                continue
            if status != 204:
                log.warning("the Hub answered %s: %s", status, job)
        except OSError as error:
            log.warning("the Hub isn't answering: %s", error)
        stop.wait(poll)


def wanted() -> dict[str, tuple[str, str]]:
    """The built-in agents to run: key → (kind, job key)."""
    with Session(get_engine()) as db:
        rows = db.execute(
            select(Agent.key, Agent.kind, Task.key)
            .join(Task, Task.id == Agent.task_id)
            .where(Agent.kind.is_not(None))
        )
        return {key: (kind, task) for key, kind, task in rows if kind in KINDS}


def run(stop: threading.Event, url: str, poll: float) -> None:
    log.info("agents service started; the Hub is at %s", url)
    running: dict[str, tuple[threading.Thread, threading.Event]] = {}
    while not stop.is_set():
        try:
            agents = wanted()
        except SQLAlchemyError:
            log.warning("database unreachable, retrying in %.0fs", LOOK_SECONDS)
            stop.wait(LOOK_SECONDS)
            continue
        for key, (thread, done) in list(running.items()):
            if key not in agents or not thread.is_alive():
                done.set()
                del running[key]
        for key, (kind, task) in agents.items():
            if key in running:
                continue
            done = threading.Event()
            hub = HubClient(url, runner_token(key))
            thread = threading.Thread(
                target=run_agent,
                args=(hub, KINDS[kind], task, done, poll),
                name=f"agent-{key}",
                daemon=True,
            )
            thread.start()
            running[key] = (thread, done)
            log.info("started the built-in agent %s (%s, job %s)", key, kind, task)
        stop.wait(LOOK_SECONDS)
    for _, done in running.values():
        done.set()
    log.info("agents service stopped")


def main() -> None:
    logs.setup(json_logs=get_settings().json_logs)
    stop = threading.Event()

    def _stop(_signum: int, _frame: FrameType | None) -> None:
        stop.set()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    url = os.environ.get("HUB_URL", "http://api:8000")
    run(stop, url, float(os.environ.get("RUNNER_POLL_SECONDS", "30")))


if __name__ == "__main__":
    main()
