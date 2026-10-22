"""Preview and check Oopsware's small local static page; never publish it."""

import argparse
from functools import partial
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "website/public"


class LocalLinks(HTMLParser):
    """Collect references that must resolve in the static artifact."""

    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in ("href", "src") and value:
                parsed = urlsplit(value)
                if not parsed.scheme and not parsed.netloc and parsed.path:
                    self.links.append(unquote(parsed.path))


def check():
    """Check actual local asset references without contacting any service."""
    pages = sorted(SITE.rglob("*.html"))
    if SITE / "index.html" not in pages:
        raise SystemExit("Missing website/public/index.html")
    for page in pages:
        parser = LocalLinks()
        parser.feed(page.read_text())
        for link in parser.links:
            target = (SITE / link.lstrip("/") if link.startswith("/") else page.parent / link).resolve()
            if not target.is_relative_to(SITE.resolve()) or not target.exists():
                raise SystemExit(f"{page.relative_to(ROOT)}: missing local asset {link}")
    print(f"Checked {len(pages)} local page(s) and their asset references.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "serve"))
    parser.add_argument("--port", type=int, default=4173)
    args = parser.parse_args()
    check()
    if args.command == "serve":
        handler = partial(SimpleHTTPRequestHandler, directory=str(SITE))
        with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
            print(f"Oopsware local page: http://127.0.0.1:{args.port}/", flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass


if __name__ == "__main__":
    main()
