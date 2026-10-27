"""Outgoing email over SMTP: invites, password resets and test emails; alerts from step 8.

SMTP is entered on the Connections screen. Until it is, every email is "not sent", so the
Owner is shown invite and reset links to pass on another way.
"""

import logging
import smtplib
import ssl
from email.message import EmailMessage
from typing import Annotated, Protocol

from fastapi import Depends

from app import connections
from app.config import Settings, get_settings

log = logging.getLogger(__name__)


class Mailer(Protocol):
    def send(self, to: str, subject: str, body: str) -> bool:
        """Send a plain-text email. Returns False when it was not sent."""
        ...


class UnconfiguredMailer:
    """Used while SMTP is not set up. Never sends; logs the email outside production."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def send(self, to: str, subject: str, body: str) -> bool:
        if self.settings.is_production:
            log.warning("email not configured; not sending %r to %s", subject, to)
        else:
            log.info("email not configured; would send to %s:\n%s\n%s", to, subject, body)
        return False


class SmtpMailer:
    def __init__(self, values: dict[str, str]) -> None:
        self.host = values["smtp_host"]
        self.port = int(values.get("smtp_port") or 587)
        self.user = values.get("smtp_user", "")
        self.password = values.get("smtp_password", "")
        self.sender = values["smtp_from"]

    def send(self, to: str, subject: str, body: str) -> bool:
        msg = EmailMessage()
        msg["From"] = self.sender
        msg["To"] = to
        msg["Subject"] = subject
        msg.set_content(body)
        try:
            context = ssl.create_default_context()
            if self.port == 465:
                with smtplib.SMTP_SSL(self.host, self.port, context=context, timeout=15) as smtp:
                    self._deliver(smtp, msg)
            else:
                with smtplib.SMTP(self.host, self.port, timeout=15) as smtp:
                    smtp.starttls(context=context)
                    self._deliver(smtp, msg)
        except (OSError, smtplib.SMTPException) as error:
            log.warning("could not send email to %s: %s", to, type(error).__name__)
            return False
        return True

    def _deliver(self, smtp: smtplib.SMTP, msg: EmailMessage) -> None:
        if self.user:
            smtp.login(self.user, self.password)
        smtp.send_message(msg)


def get_mailer() -> Mailer:
    values = connections.current()
    if connections.ready(values, "email"):
        return SmtpMailer(values)
    return UnconfiguredMailer(get_settings())


MailerDep = Annotated[Mailer, Depends(get_mailer)]


def invite_email(name: str, invited_by: str, link: str) -> tuple[str, str]:
    return (
        "You're invited to the GridRankers Agent Hub",
        f"Hi {name},\n\n"
        f"{invited_by} has invited you to the GridRankers Agent Hub.\n\n"
        f"Set your password here (the link works once and expires in 7 days):\n{link}\n",
    )


def reset_email(name: str, link: str) -> tuple[str, str]:
    return (
        "Reset your Agent Hub password",
        f"Hi {name},\n\n"
        f"Use this link to set a new password (it works once and expires in 1 hour):\n{link}\n\n"
        "If you didn't ask for this, you can ignore this email.\n",
    )
