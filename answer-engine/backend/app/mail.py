"""Outgoing email over SMTP. Notification emails arrive in build step 12."""

import logging
import smtplib
import ssl
from email.message import EmailMessage
from typing import Annotated, Protocol

from fastapi import Depends

from app.config import Settings, get_settings

log = logging.getLogger(__name__)


class Mailer(Protocol):
    def send(self, to: str, subject: str, body: str) -> bool:
        """Send a plain-text email. Returns False when it was not sent."""
        ...


class SmtpMailer:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def send(self, to: str, subject: str, body: str) -> bool:
        s = self.settings
        msg = EmailMessage()
        msg["From"] = s.smtp_from
        msg["To"] = to
        msg["Subject"] = subject
        msg.set_content(body)
        try:
            context = ssl.create_default_context()
            if s.smtp_port == 465:
                with smtplib.SMTP_SSL(
                    s.smtp_host, s.smtp_port, context=context, timeout=15
                ) as smtp:
                    self._deliver(smtp, msg)
            else:
                with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=15) as smtp:
                    smtp.starttls(context=context)
                    self._deliver(smtp, msg)
        except (OSError, smtplib.SMTPException):
            log.exception("could not send email to %s", to)
            return False
        return True

    def _deliver(self, smtp: smtplib.SMTP, msg: EmailMessage) -> None:
        if self.settings.smtp_user:
            smtp.login(self.settings.smtp_user, self.settings.smtp_password)
        smtp.send_message(msg)


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


def get_mailer() -> Mailer:
    settings = get_settings()
    return SmtpMailer(settings) if settings.email_configured else UnconfiguredMailer(settings)


MailerDep = Annotated[Mailer, Depends(get_mailer)]


def invite_email(name: str, invited_by: str, link: str) -> tuple[str, str]:
    return (
        "You're invited to the GridRankers Answer Engine",
        f"Hi {name},\n\n"
        f"{invited_by} has invited you to the GridRankers Answer Engine.\n\n"
        f"Set your password here (the link works once and expires in 72 hours):\n{link}\n",
    )


def reset_email(name: str, link: str) -> tuple[str, str]:
    return (
        "Reset your Answer Engine password",
        f"Hi {name},\n\n"
        f"Use this link to set a new password (it works once and expires in 1 hour):\n{link}\n\n"
        "If you didn't ask for this, you can ignore this email.\n",
    )
