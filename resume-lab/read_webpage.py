from __future__ import annotations

import json
import re
import sys
from html.parser import HTMLParser


class PageText(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, bool, bool]] = []
        self.lines: list[str] = []
        self.main_lines: list[str] = []
        self.structured: list[str] = []
        self.json_script = False
        self.script_text = ""

    def emit(self, value: str) -> None:
        if any(skip for _, skip, _ in self.stack):
            return
        self.lines.append(value)
        if any(main for _, _, main in self.stack):
            self.main_lines.append(value)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if len(self.stack) > 256:
            raise ValueError("This page has too many nested elements.")
        attributes = dict(attrs)
        if tag == "script" and attributes.get("type") == "application/ld+json":
            self.json_script = True
            self.script_text = ""
        skip = tag in {"script", "style", "nav", "footer", "aside", "noscript", "svg"} or "hidden" in attributes or attributes.get("aria-hidden") == "true"
        main = tag in {"main", "article"} or attributes.get("role") == "main"
        if tag in {"br", "hr"}:
            self.emit("\n")
        elif tag not in {"meta", "link", "img", "input", "source", "wbr", "area", "base", "embed", "param", "track"}:
            if tag in {"p", "div", "section", "li", "h1", "h2", "h3", "h4", "tr"}:
                self.emit("\n")
            self.stack.append((tag, skip or tag == "head", main))

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self.json_script:
            self.structured.append(self.script_text)
            self.json_script = False
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                break
        if tag in {"p", "div", "section", "li", "h1", "h2", "h3", "h4", "tr", "main", "article"}:
            self.emit("\n")

    def handle_data(self, data: str) -> None:
        if self.json_script:
            self.script_text += data
        self.emit(data)


def plain_html(value: str, main_only: bool = False) -> str:
    parser = PageText()
    parser.feed(value)
    parts = parser.main_lines if main_only and len("".join(parser.main_lines)) >= 100 else parser.lines
    return "\n".join(line.strip() for line in re.sub(r"[ \t\f\v]+", " ", "".join(parts)).splitlines() if line.strip())


def find_posting(value: object, depth: int = 0) -> dict | None:
    if depth > 12:
        return None
    if isinstance(value, dict):
        kinds = value.get("@type", [])
        if kinds == "JobPosting" or isinstance(kinds, list) and "JobPosting" in kinds:
            return value
        for key in ("@graph", "mainEntity", "itemListElement"):
            if found := find_posting(value.get(key), depth + 1):
                return found
    elif isinstance(value, list):
        for child in value[:200]:
            if found := find_posting(child, depth + 1):
                return found
    return None


def extract_page(html: str, target: str) -> str:
    parser = PageText()
    parser.feed(html)
    if target == "job":
        for script in parser.structured[:30]:
            try:
                posting = find_posting(json.loads(script))
            except (ValueError, RecursionError):
                continue
            if posting and isinstance(posting.get("description"), str):
                parts: list[str] = []
                for key in ("title", "description", "responsibilities", "qualifications", "skills", "experienceRequirements", "educationRequirements"):
                    if isinstance(posting.get(key), str):
                        parts.append(plain_html(posting[key]))
                organization = posting.get("hiringOrganization")
                if isinstance(organization, dict) and isinstance(organization.get("name"), str):
                    parts.insert(1, organization["name"])
                return "\n\n".join(parts)
    return plain_html(html, main_only=target == "job")


if __name__ == "__main__":
    try:
        html = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
        if len(html) > 8 * 1024 * 1024:
            raise ValueError("Web page exceeds the 8 MB import limit.")
        print(json.dumps({"text": extract_page(html.decode("utf-8-sig", errors="replace"), sys.argv[1])}))
    except Exception:
        print(json.dumps({"error": "This web page could not be read. Upload a file or paste its text instead."}))
