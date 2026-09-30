"""Optional publisher domain verification by DNS TXT record (D6).

The publisher publishes `navide-verify=<token>` at `_navide-verify.<domain>`.
The resolver is injected (`RegistryState.txt_resolver`) so tests never touch
DNS; the default asks a DNS-over-HTTPS JSON endpoint with the standard
library, which avoids adding a DNS dependency to the image.
"""

from __future__ import annotations

import json
import re
import secrets
import urllib.parse
import urllib.request
from typing import Callable

TxtResolver = Callable[[str], list[str]]

TXT_PREFIX = "_navide-verify"
VALUE_PREFIX = "navide-verify="
DOH_URL = "https://cloudflare-dns.com/dns-query"

_LABEL = r"(?!-)[a-z0-9-]{1,63}(?<!-)"
DOMAIN_RE = re.compile(rf"^(?:{_LABEL}\.)+[a-z]{{2,63}}$")


class DomainError(ValueError):
    pass


def normalize_domain(value: str) -> str:
    domain = value.strip().lower().rstrip(".")
    if len(domain) > 253 or not DOMAIN_RE.fullmatch(domain):
        raise DomainError("Enter a domain name such as example.com.")
    return domain


def new_token() -> str:
    return secrets.token_hex(10)


def record_host(domain: str) -> str:
    return f"{TXT_PREFIX}.{domain}"


def record_value(token: str) -> str:
    return f"{VALUE_PREFIX}{token}"


def is_verified(domain: str, token: str, resolver: TxtResolver) -> bool:
    """True when any TXT string at the record host equals the expected value.
    A resolver failure counts as "not found yet", never as verified."""
    try:
        values = resolver(record_host(domain))
    except Exception:  # noqa: BLE001 - any lookup failure is "not yet"
        return False
    expected = record_value(token)
    return any(value.strip().strip('"') == expected for value in values)


def doh_txt_resolver(name: str) -> list[str]:  # pragma: no cover - network
    query = urllib.parse.urlencode({"name": name, "type": "TXT"})
    request = urllib.request.Request(
        f"{DOH_URL}?{query}", headers={"Accept": "application/dns-json"}
    )
    with urllib.request.urlopen(request, timeout=5) as response:  # noqa: S310
        body = json.loads(response.read().decode("utf-8"))
    return [
        answer.get("data", "")
        for answer in body.get("Answer", [])
        if answer.get("type") == 16
    ]
