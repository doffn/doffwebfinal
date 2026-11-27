import logging
import os
import re
import requests

from django.conf import settings
from django.contrib import messages
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.shortcuts import redirect, render
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods

logger = logging.getLogger(__name__)

TELEGRAM_API = "https://api.telegram.org/bot{token}/{method}"
MAX_UPLOAD_BYTES = 20 * 1024 * 1024

ALLOWED_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".webp", ".gif",
    ".mp4", ".mov", ".webm",
    ".mp3", ".m4a", ".ogg", ".oga", ".opus", ".wav",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx",
    ".ppt", ".pptx", ".txt", ".zip",
}


def home(request):
    return render(request, "myApp/index.html")


def about(request):
    return redirect("home")


def service(request):
    return redirect("home")


def work(request):
    return redirect("home")


def _html_escape(value):
    value = str(value or "")
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _telegram_request(token, method, data=None, files=None, timeout=30):
    url = TELEGRAM_API.format(token=token, method=method)

    response = requests.post(
        url,
        data=data,
        files=files,
        timeout=timeout,
    )

    try:
        result = response.json()
    except ValueError:
        logger.error(
            "Telegram returned invalid JSON. HTTP status: %s",
            response.status_code,
        )
        response.raise_for_status()
        raise RuntimeError("Invalid response from Telegram.")

    if not response.ok or not result.get("ok"):
        error_description = result.get(
            "description", "Unknown Telegram API error"
        )
        error_code = result.get("error_code", response.status_code)

        logger.error(
            "Telegram API failure. Method=%s Code=%s Error=%s",
            method,
            error_code,
            error_description,
        )

        raise RuntimeError(
            f"Telegram API error ({error_code}): {error_description}"
        )

    return result


def _telegram_send(name, email, message, attachment=None):
    token = str(getattr(settings, "TELEGRAM_BOT_TOKEN", "") or "").strip()
    chat_id = str(getattr(settings, "TELEGRAM_CHAT_ID", "") or "").strip()

    if not token or not chat_id:
        raise RuntimeError(
            "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing."
        )

    clean_message = (message or "").strip()

    text = (
        "<b>New portfolio contact</b>\n"
        f"<b>Name:</b> {_html_escape(name)}\n"
        f"<b>Email:</b> {_html_escape(email)}\n"
        f"<b>Message:</b> {_html_escape(clean_message or '(No text supplied)')}"
    )

    _telegram_request(
        token,
        "sendMessage",
        data={
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        },
        timeout=20,
    )

    if not attachment:
        return

    filename = os.path.basename(attachment.name)
    ext = os.path.splitext(filename.lower())[1]
    content_type = attachment.content_type or "application/octet-stream"

    if ext == ".gif" or content_type == "image/gif":
        method, field = "sendAnimation", "animation"
    elif ext in {".jpg", ".jpeg", ".png"} or content_type in {
        "image/jpeg",
        "image/png",
    }:
        method, field = "sendPhoto", "photo"
    elif content_type.startswith("video/") or ext in {".mp4", ".mov", ".webm"}:
        method, field = "sendVideo", "video"
    elif content_type.startswith("audio/") or ext in {
        ".mp3", ".m4a", ".ogg", ".oga", ".opus", ".wav",
    }:
        if ext in {".ogg", ".oga", ".opus"}:
            method, field = "sendVoice", "voice"
        else:
            method, field = "sendAudio", "audio"
    else:
        # Includes .webp, .pdf, Office docs, .txt, .zip
        method, field = "sendDocument", "document"

    attachment.seek(0)
    file_obj = getattr(attachment, "file", attachment)

    _telegram_request(
        token,
        method,
        data={"chat_id": chat_id},
        files={
            field: (filename, file_obj, content_type)
        },
        timeout=45,
    )


@require_http_methods(["GET", "POST"])
@csrf_protect
def contact(request):
    if request.method == "GET":
        return render(request, "myApp/contact.html")

    # Honeypot anti-spam field
    if request.POST.get("website", "").strip():
        messages.success(request, "Thanks. Your message has been received.")
        return redirect("contact")

    ip = (
        request.META.get("HTTP_X_FORWARDED_FOR", "").split(",")[0].strip()
        or request.META.get("REMOTE_ADDR", "unknown")
    )

    rate_key = "portfolio-contact:" + re.sub(r"[^a-zA-Z0-9_.:-]", "_", ip)

    if cache.get(rate_key):
        messages.error(
            request,
            "Please wait a little before sending another message.",
        )
        return redirect("contact")

    name = request.POST.get("name", "").strip()
    email = request.POST.get("email", "").strip()
    message = request.POST.get("message", "").strip()
    attachment = request.FILES.get("attachment")

    if not name or not email or (not message and not attachment):
        messages.error(
            request,
            "Please provide your name, email and a message or attachment.",
        )
        return redirect("contact")

    if len(name) > 100 or len(email) > 254 or len(message) > 3000:
        messages.error(
            request,
            "One or more fields exceed the allowed length.",
        )
        return redirect("contact")

    try:
        validate_email(email)
    except ValidationError:
        messages.error(request, "Please enter a valid email address.")
        return redirect("contact")

    if attachment:
        ext = os.path.splitext(attachment.name.lower())[1]

        if attachment.size > MAX_UPLOAD_BYTES:
            messages.error(
                request,
                "Attachments must be 20 MB or smaller.",
            )
            return redirect("contact")

        if ext in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
            if attachment.size > 10 * 1024 * 1024:
                messages.error(
                    request,
                    "Images must be 10 MB or smaller.",
                )
                return redirect("contact")

        if ext not in ALLOWED_EXTENSIONS:
            messages.error(
                request,
                "That file type is not supported.",
            )
            return redirect("contact")

    try:
        _telegram_send(name, email, message, attachment)
        cache.set(rate_key, True, timeout=45)
        messages.success(
            request,
            "Your message has been sent. Thank you for reaching out!",
        )

    except requests.RequestException:
        logger.exception("Network error while contacting Telegram.")
        messages.error(
            request,
            "The message could not be delivered right now. "
            "Please try again later or email me directly.",
        )

    except Exception:
        logger.exception("Telegram contact service error.")
        messages.error(
            request,
            "The contact service is temporarily unavailable. "
            "Please email me directly.",
        )

    return redirect("contact")