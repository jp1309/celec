#!/usr/bin/env python3
"""
Download CELEC daily monitoring PDFs from a public Nextcloud share.

The robot opens the public share first to obtain the session cookies and
request token, then lists files through the public WebDAV endpoint.
"""

from __future__ import annotations

import argparse
import base64
import csv
import datetime as dt
import http.cookiejar
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path


DEFAULT_SHARE_URL = "https://celecloud.celec.gob.ec/s/fH4f7pr5y9XBsxn"
DEFAULT_OUTPUT_DIR = Path("downloads") / "celec_pdfs"
DEFAULT_MANIFEST = Path("manifests") / "celec_pdfs_manifest.csv"

DAV_NS = "DAV:"
OC_NS = "http://owncloud.org/ns"
NC_NS = "http://nextcloud.org/ns"
OCS_NS = "http://open-collaboration-services.org/ns"
NS = {"d": DAV_NS, "oc": OC_NS, "nc": NC_NS, "ocs": OCS_NS}


@dataclass(frozen=True)
class RemoteItem:
    path: str
    is_dir: bool
    size: int
    modified: str
    content_type: str
    etag: str
    report_date: dt.date | None


class CelecNextcloudClient:
    def __init__(self, share_url: str, timeout: int) -> None:
        parsed = urllib.parse.urlparse(share_url.rstrip("/"))
        if not parsed.scheme or not parsed.netloc:
            raise ValueError(f"Invalid share URL: {share_url}")

        token = parsed.path.rstrip("/").split("/")[-1]
        if not token:
            raise ValueError(f"Could not extract share token from: {share_url}")

        self.base_url = f"{parsed.scheme}://{parsed.netloc}"
        self.share_url = share_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.request_token = ""
        self.cookie_jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookie_jar)
        )

    def open_share(self) -> None:
        with self.opener.open(self.share_url, timeout=self.timeout) as response:
            html = response.read().decode("utf-8", "replace")

        self.request_token = self._extract_request_token(html)
        if not self.request_token:
            raise RuntimeError("Could not find Nextcloud request token in share page")

    def list_dir(self, remote_dir: str) -> list[RemoteItem]:
        url = self._webdav_url(remote_dir, directory=True)
        body = (
            '<?xml version="1.0"?>'
            '<d:propfind xmlns:d="DAV:" '
            'xmlns:oc="http://owncloud.org/ns" '
            'xmlns:nc="http://nextcloud.org/ns" '
            'xmlns:ocs="http://open-collaboration-services.org/ns">'
            "<d:prop>"
            "<d:displayname/>"
            "<d:getcontentlength/>"
            "<d:getlastmodified/>"
            "<d:getcontenttype/>"
            "<d:getetag/>"
            "<d:resourcetype/>"
            "<oc:size/>"
            "</d:prop>"
            "</d:propfind>"
        ).encode("utf-8")

        request = self._request(url, data=body, method="PROPFIND")
        request.add_header("Depth", "1")
        request.add_header("Content-Type", "application/xml; charset=utf-8")
        with self.opener.open(request, timeout=self.timeout) as response:
            payload = response.read()

        items = self._parse_propfind(payload)
        current = normalize_remote_dir(remote_dir)
        return [item for item in items if item.path.rstrip("/") != current.rstrip("/")]

    def download_file(self, remote_path: str, target_path: Path, size: int) -> str:
        if target_path.exists() and size and target_path.stat().st_size == size:
            return "skipped"

        target_path.parent.mkdir(parents=True, exist_ok=True)
        partial_path = target_path.with_name(target_path.name + ".part")
        if partial_path.exists():
            partial_path.unlink()

        request = self._request(self._webdav_url(remote_path, directory=False))
        downloaded = 0
        with self.opener.open(request, timeout=self.timeout) as response:
            with partial_path.open("wb") as file:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    file.write(chunk)
                    downloaded += len(chunk)

        if size and downloaded != size:
            partial_path.unlink(missing_ok=True)
            raise IOError(
                f"Incomplete download for {remote_path}: {downloaded} of {size} bytes"
            )

        os.replace(partial_path, target_path)
        return "downloaded"

    def _request(
        self, url: str, data: bytes | None = None, method: str | None = None
    ) -> urllib.request.Request:
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("X-Requested-With", "XMLHttpRequest")
        request.add_header("requesttoken", self.request_token)
        request.add_header(
            "Authorization",
            "Basic " + base64.b64encode(f"{self.token}:".encode()).decode(),
        )
        request.add_header("User-Agent", "celec-pdf-robot/1.0")
        return request

    def _webdav_url(self, remote_path: str, directory: bool) -> str:
        quoted = quote_remote_path(remote_path)
        url = f"{self.base_url}/public.php/webdav"
        if quoted:
            url = f"{url}/{quoted}"
        if directory and not url.endswith("/"):
            url += "/"
        return url

    def _parse_propfind(self, payload: bytes) -> list[RemoteItem]:
        root = ET.fromstring(payload)
        items: list[RemoteItem] = []
        for response in root.findall("d:response", NS):
            href = response.findtext("d:href", default="", namespaces=NS)
            path = href_to_remote_path(href)
            if path is None:
                continue

            prop = response.find("d:propstat/d:prop", NS)
            if prop is None:
                continue

            size_text = (
                prop.findtext("d:getcontentlength", default="", namespaces=NS)
                or prop.findtext("oc:size", default="", namespaces=NS)
                or "0"
            )
            items.append(
                RemoteItem(
                    path=path,
                    is_dir=prop.find("d:resourcetype/d:collection", NS) is not None,
                    size=int(size_text) if size_text.isdigit() else 0,
                    modified=prop.findtext(
                        "d:getlastmodified", default="", namespaces=NS
                    ),
                    content_type=prop.findtext(
                        "d:getcontenttype", default="", namespaces=NS
                    ),
                    etag=prop.findtext("d:getetag", default="", namespaces=NS),
                    report_date=extract_report_date(path),
                )
            )
        return items

    @staticmethod
    def _extract_request_token(html: str) -> str:
        patterns = [
            r'data-requesttoken="([^"]+)"',
            r'name="requesttoken"\s+value="([^"]+)"',
            r'id="publicUploadRequestToken"[^>]+value="([^"]+)"',
        ]
        for pattern in patterns:
            match = re.search(pattern, html)
            if match:
                return match.group(1)
        return ""


def normalize_remote_dir(path: str) -> str:
    return path.strip("/")


def quote_remote_path(path: str) -> str:
    normalized = path.strip("/")
    if not normalized:
        return ""
    return "/".join(urllib.parse.quote(part) for part in normalized.split("/"))


def href_to_remote_path(href: str) -> str | None:
    decoded_path = urllib.parse.unquote(urllib.parse.urlparse(href).path)
    marker = "/public.php/webdav/"
    if decoded_path == "/public.php/webdav":
        return ""
    if marker not in decoded_path:
        return None
    return decoded_path.split(marker, 1)[1].strip("/")


def extract_report_date(path: str) -> dt.date | None:
    name = Path(path).name
    candidates = [name, path]
    for text in candidates:
        match = re.search(r"(?<!\d)(\d{1,2})[ _.-]+(\d{1,2})[ _.-]+(20\d{2})(?!\d)", text)
        if match:
            return safe_date(int(match.group(3)), int(match.group(2)), int(match.group(1)))

        match = re.search(r"(?<!\d)(20\d{2})[ _.-]+(\d{1,2})[ _.-]+(\d{1,2})(?!\d)", text)
        if match:
            return safe_date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    return None


def safe_date(year: int, month: int, day: int) -> dt.date | None:
    try:
        return dt.date(year, month, day)
    except ValueError:
        return None


def leading_year(path: str) -> int | None:
    first = path.strip("/").split("/", 1)[0]
    if re.fullmatch(r"20\d{2}", first):
        return int(first)
    return None


def should_download_pdf(item: RemoteItem, since: dt.date) -> bool:
    if item.is_dir or not item.path.lower().endswith(".pdf"):
        return False
    if item.report_date:
        return item.report_date >= since
    year = leading_year(item.path)
    return year is not None and year >= since.year


def sanitize_part(part: str) -> str:
    return re.sub(r'[<>:"\\|?*]', "_", part).strip() or "_"


def local_path_for(output_dir: Path, remote_path: str) -> Path:
    return output_dir.joinpath(*(sanitize_part(part) for part in remote_path.split("/")))


def discover_pdfs(client: CelecNextcloudClient, since: dt.date) -> list[RemoteItem]:
    stack = [""]
    pdfs: list[RemoteItem] = []

    while stack:
        current_dir = stack.pop()
        for item in client.list_dir(current_dir):
            if item.is_dir:
                year = leading_year(item.path)
                if year is None or year >= since.year:
                    stack.append(item.path)
                continue

            if should_download_pdf(item, since):
                pdfs.append(item)

    return sorted(pdfs, key=lambda item: (item.report_date or dt.date.min, item.path))


def write_manifest(manifest_path: Path, rows: list[dict[str, str]]) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "report_date",
        "remote_path",
        "local_path",
        "size_bytes",
        "modified",
        "etag",
        "status",
    ]
    with manifest_path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download CELEC public-share daily PDF reports from 2024 onward."
    )
    parser.add_argument("--share-url", default=DEFAULT_SHARE_URL)
    parser.add_argument("--since", default="2024-01-01", help="YYYY-MM-DD")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--dry-run", action="store_true", help="List only")
    parser.add_argument("--limit", type=int, default=0, help="Download at most N files")
    parser.add_argument("--delay", type=float, default=0.0, help="Seconds between files")
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=120)
    return parser.parse_args(argv)


def run(argv: list[str]) -> int:
    args = parse_args(argv)
    since = dt.date.fromisoformat(args.since)

    client = CelecNextcloudClient(args.share_url, timeout=args.timeout)
    print(f"Opening share: {args.share_url}")
    client.open_share()

    print(f"Listing PDF reports since {since.isoformat()}...")
    pdfs = discover_pdfs(client, since)
    if args.limit:
        pdfs = pdfs[: args.limit]

    total_size = sum(item.size for item in pdfs)
    latest = max((item.report_date for item in pdfs if item.report_date), default=None)
    print(f"Found {len(pdfs)} PDFs ({total_size:,} bytes).")
    if latest:
        print(f"Latest available report date: {latest.isoformat()}")

    rows: list[dict[str, str]] = []
    for index, item in enumerate(pdfs, start=1):
        local_path = local_path_for(args.output_dir, item.path)
        status = "dry-run"

        if not args.dry_run:
            for attempt in range(1, args.retries + 1):
                try:
                    status = client.download_file(item.path, local_path, item.size)
                    break
                except (OSError, urllib.error.URLError, TimeoutError) as exc:
                    if attempt == args.retries:
                        status = f"error: {exc}"
                    else:
                        wait = min(30, 2**attempt)
                        print(
                            f"[{index}/{len(pdfs)}] retry {attempt}/{args.retries} "
                            f"after error: {exc}"
                        )
                        time.sleep(wait)

            if args.delay:
                time.sleep(args.delay)

        print(f"[{index}/{len(pdfs)}] {status}: {item.path}")
        rows.append(
            {
                "report_date": item.report_date.isoformat() if item.report_date else "",
                "remote_path": item.path,
                "local_path": str(local_path),
                "size_bytes": str(item.size),
                "modified": item.modified,
                "etag": item.etag,
                "status": status,
            }
        )

    write_manifest(args.manifest, rows)
    print(f"Manifest written: {args.manifest}")

    errors = [row for row in rows if row["status"].startswith("error:")]
    if errors:
        print(f"Completed with {len(errors)} errors.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:]))
