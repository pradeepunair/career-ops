from __future__ import annotations

import io
import json
import sys
import zipfile
from xml.etree import ElementTree


def extract_docx(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > 2000 or sum(item.file_size for item in entries) > 64 * 1024 * 1024:
            raise ValueError("This Word file expands beyond the upload limit.")
        document = archive.getinfo("word/document.xml")
        if document.file_size > 6 * 1024 * 1024:
            raise ValueError("This Word document is too large to read safely.")
        xml = archive.read(document)
        if b"<!DOCTYPE" in xml.upper() or b"<!ENTITY" in xml.upper():
            raise ValueError("This Word file contains unsupported XML declarations.")
        root = ElementTree.fromstring(xml)
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        lines: list[str] = []
        for paragraph in root.findall(".//w:body//w:p", ns):
            parts: list[str] = []
            for element in paragraph.iter():
                if element.tag == f"{{{ns['w']}}}t":
                    parts.append(element.text or "")
                elif element.tag == f"{{{ns['w']}}}tab":
                    parts.append("\t")
                elif element.tag in {f"{{{ns['w']}}}br", f"{{{ns['w']}}}cr"}:
                    parts.append("\n")
            if line := "".join(parts).strip():
                lines.append(line)
        return "\n".join(lines)


def extract_pdf(data: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as error:
        raise ValueError("PDF reading needs pypdf. Follow the upload setup instructions in the Resume Lab README.") from error
    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        raise ValueError("This PDF is password-protected. Upload an unlocked copy or paste its text.")
    if len(reader.pages) > 30:
        raise ValueError("Use a PDF with no more than 30 pages.")
    parts: list[str] = []
    size = 0
    for page in reader.pages:
        text = page.extract_text() or ""
        size += len(text)
        if size > 50000:
            raise ValueError("The PDF contains too much text. Upload only the relevant pages.")
        parts.append(text)
    return "\n\n".join(parts)


def main() -> None:
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024, 768 * 1024 * 1024))
    except (ImportError, ValueError, OSError):
        pass
    try:
        data = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
        if len(data) > 8 * 1024 * 1024:
            raise ValueError("Use a file of 8 MB or less.")
        kind = sys.argv[1]
        if kind == ".docx":
            text = extract_docx(data)
        elif kind == ".pdf":
            text = extract_pdf(data)
        else:
            raise ValueError("Use a PDF, DOCX, TXT, or Markdown file.")
        if len(text) > 50000:
            raise ValueError("This document contains too much text. Upload a shorter document.")
        print(json.dumps({"text": text}))
    except ValueError as error:
        print(json.dumps({"error": str(error)}))
    except Exception:
        print(json.dumps({"error": "This document could not be read. Upload a valid, unlocked PDF or DOCX, or paste its text."}))


if __name__ == "__main__":
    main()
