"""OpenGov reporting API client.

Thin wrapper over the unauthenticated `reporting.opengov.com` endpoints
that back every Tampa Transparency dashboard. No auth required.

See PLAN.md for endpoint discovery notes.
"""

from __future__ import annotations

import time
from typing import Any

import httpx

DEFAULT_BASE_URL = "https://reporting.opengov.com"
DEFAULT_TIMEOUT = 60.0
DEFAULT_USER_AGENT = "meetings-opengov/0.1"


class OpenGovError(RuntimeError):
    """Raised when the OpenGov API returns a non-2xx response we can't recover from."""


class OpenGovClient:
    """Minimal client for the public OpenGov reporting/transparency APIs."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        user_agent: str = DEFAULT_USER_AGENT,
        max_retries: int = 3,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.max_retries = max_retries
        self._client = httpx.Client(
            timeout=timeout,
            headers={
                "Accept": "application/json",
                "User-Agent": user_agent,
            },
        )

    def __enter__(self) -> "OpenGovClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    # ------------------------------------------------------------------
    # Low-level request with retry on 5xx / network errors
    # ------------------------------------------------------------------
    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        url = f"{self.base_url}{path}"
        last_exc: Exception | None = None
        for attempt in range(self.max_retries):
            try:
                resp = self._client.request(method, url, **kwargs)
            except httpx.HTTPError as exc:
                last_exc = exc
            else:
                if resp.status_code < 500:
                    if resp.status_code >= 400:
                        raise OpenGovError(
                            f"{method} {url} -> {resp.status_code}: {resp.text[:300]}"
                        )
                    return resp
                last_exc = OpenGovError(
                    f"{method} {url} -> {resp.status_code}: {resp.text[:300]}"
                )
            time.sleep(0.5 * (2**attempt))
        assert last_exc is not None
        raise last_exc

    # ------------------------------------------------------------------
    # Public endpoints
    # ------------------------------------------------------------------
    def get_entity(self, slug: str) -> dict[str, Any]:
        """Resolve entity metadata by slug, e.g. ``"tampa"``.

        Returns the raw JSON; useful fields include ``id`` (legacy int),
        ``uuid``, ``default_coa_id``, and ``name``.
        """
        return self._request("GET", f"/api/v1/entities/{slug}").json()

    def get_report(self, report_id: int | str) -> dict[str, Any]:
        """Fetch report metadata: ``data_sets``, ``coa_id``, ``coa_mask_id``."""
        return self._request("GET", f"/api/v1/reports/{report_id}").json()

    def get_data_set(self, data_set_id: str) -> dict[str, Any]:
        """Fetch dataset metadata, including ``etag`` for change detection."""
        return self._request("GET", f"/api/v1/data_sets/{data_set_id}").json()

    def get_package(
        self,
        coa_id: str,
        *,
        coa_mask_id: int | None,
        data_set_ids: list[str],
        mask: Any = None,
        serve_old: bool = True,
        state_scale: bool = False,
        ungroup: Any = None,
        api: Any = None,
    ) -> dict[str, Any]:
        """Fetch the chart-of-accounts package for a CoA + dataset set.

        Returns the full ~1MB JSON response with ``nodes``, ``trees``,
        ``data_sets``, and ``cache_key``.
        """
        body = {
            "coa_mask_id": coa_mask_id,
            "data_sets": data_set_ids,
            "mask": mask,
            "serve_old": serve_old,
            "state_scale": state_scale,
            "ungroup": ungroup,
            "api": api,
        }
        return self._request(
            "POST",
            f"/api/transparency/v1/package/{coa_id}",
            json=body,
        ).json()

    # ------------------------------------------------------------------
    # Convenience composition
    # ------------------------------------------------------------------
    def get_package_for_report(self, report_id: int | str) -> dict[str, Any]:
        """One-shot: fetch a report's metadata and then its package."""
        report = self.get_report(report_id)
        coa_id = report["coa_id"]
        coa_mask_id = report.get("coa_mask_id")
        data_set_ids = [ds["id"] for ds in report.get("data_sets", [])]
        if not data_set_ids:
            raise OpenGovError(f"report {report_id} has no data_sets")
        return self.get_package(
            coa_id,
            coa_mask_id=coa_mask_id,
            data_set_ids=data_set_ids,
        )
