from __future__ import annotations

import io
import json
import re
import sys
from pathlib import Path
from xml.sax.saxutils import escape


def lines(markdown: str) -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []
    for line in markdown.splitlines():
        line = line.strip()
        if not line:
            continue
        heading = re.match(r"^(#{1,3})\s+(.+)$", line)
        bullet = re.match(r"^[-*]\s+(.+)$", line)
        kind, text = (f"h{len(heading[1])}", heading[2]) if heading else ("bullet", bullet[1]) if bullet else ("p", line)
        text = re.sub(r"\*\*(.*?)\*\*", r"\1", text)
        text = re.sub(r"\[(.*?)\]\((.*?)\)", r"\1 (\2)", text)
        text = text.replace("\u2011", "-")
        text = "".join(char for char in text if ord(char) >= 32 or char == "\t")
        result.append((kind, text))
    return result


def create_docx(content: list[tuple[str, str]]) -> bytes:
    from docx import Document
    from docx.shared import Inches, Pt, RGBColor

    document = Document()
    section = document.sections[0]
    section.page_width, section.page_height = Inches(8.5), Inches(11)
    section.top_margin = section.bottom_margin = Inches(0.55)
    section.left_margin = section.right_margin = Inches(0.6)
    for name in ("Normal", "Title", "Heading 1", "Heading 2", "Heading 3", "List Bullet"):
        style = document.styles[name]
        style.font.name = "Arial"
        style.font.color.rgb = RGBColor(0, 0, 0)
        style.font.size = Pt(10)
        style.paragraph_format.space_after = Pt(3)
        style.paragraph_format.line_spacing = 1.04
    document.styles["Title"].font.size = Pt(20)
    document.styles["Title"].font.bold = True
    for name in ("Heading 1", "Heading 2", "Heading 3"):
        style = document.styles[name]
        style.font.bold = True
        style.font.size = Pt(10.5)
        style.paragraph_format.space_before = Pt(9 if name == "Heading 1" else 6)
        style.paragraph_format.keep_with_next = True
    prior = ""
    in_header = True
    for kind, text in content:
        style = {"h1": "Title", "h2": "Heading 1", "h3": "Heading 2", "bullet": "List Bullet"}.get(kind, "Normal")
        paragraph = document.add_paragraph(text, style)
        paragraph.paragraph_format.widow_control = True
        if kind == "h2":
            in_header = False
        if in_header or kind in {"h1", "h2", "h3"}:
            paragraph.paragraph_format.keep_with_next = True
        if prior == "h3" and kind == "p":
            for run in paragraph.runs:
                run.bold = True
            paragraph.paragraph_format.keep_with_next = True
        if kind == "bullet":
            paragraph.paragraph_format.keep_together = True
        prior = kind
    document.core_properties.author = ""
    document.core_properties.title = "Resume"
    document.core_properties.subject = ""
    document.core_properties.comments = ""
    for root in (document._element, document.styles.element):
        for border in root.xpath(".//w:pBdr"):
            border.getparent().remove(border)
    output = io.BytesIO()
    document.save(output)
    return output.getvalue()


def create_pdf(content: list[tuple[str, str]]) -> bytes:
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import Paragraph, SimpleDocTemplate

    candidates = [Path("/System/Library/Fonts/Supplemental/Arial.ttf"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")]
    regular = next((path for path in candidates if path.exists()), None)
    font, bold = "Helvetica", "Helvetica-Bold"
    if regular:
        bold_path = regular.with_name("Arial Bold.ttf" if regular.name == "Arial.ttf" else "DejaVuSans-Bold.ttf")
        pdfmetrics.registerFont(TTFont("ResumeText", str(regular)))
        pdfmetrics.registerFont(TTFont("ResumeBold", str(bold_path if bold_path.exists() else regular)))
        font, bold = "ResumeText", "ResumeBold"
    styles = {
        "p": ParagraphStyle("Body", fontName=font, fontSize=10, leading=11.6, spaceAfter=3, alignment=TA_LEFT, splitLongWords=True),
        "h1": ParagraphStyle("Name", fontName=bold, fontSize=20, leading=23, spaceAfter=5, keepWithNext=True),
        "h2": ParagraphStyle("Section", fontName=bold, fontSize=10.5, leading=12, spaceBefore=9, spaceAfter=4, keepWithNext=True),
        "h3": ParagraphStyle("Employer", fontName=bold, fontSize=10.5, leading=12, spaceBefore=6, spaceAfter=3, keepWithNext=True),
        "role": ParagraphStyle("Role", fontName=bold, fontSize=10, leading=11.6, spaceAfter=3, keepWithNext=True),
        "bullet": ParagraphStyle("Bullet", fontName=font, fontSize=10, leading=11.6, spaceAfter=3, leftIndent=11, firstLineIndent=0, bulletIndent=0),
    }
    story = []
    prior = ""
    for kind, text in content:
        selected = "role" if prior == "h3" and kind == "p" else kind
        story.append(Paragraph(escape(text), styles[selected], bulletText="\u2022" if kind == "bullet" else None))
        prior = kind
    output = io.BytesIO()
    document = SimpleDocTemplate(output, pagesize=letter, topMargin=39.6, bottomMargin=39.6, leftMargin=43.2, rightMargin=43.2, title="Resume", author="", pageCompression=1)
    document.build(story)
    return output.getvalue()


if __name__ == "__main__":
    try:
        value = json.loads(sys.stdin.buffer.read(250000))
        markdown = value.get("markdown")
        if not isinstance(markdown, str) or not 100 <= len(markdown) <= 45000:
            raise ValueError("Provide a complete resume of 100 to 45,000 characters.")
        content = lines(markdown)
        kind = sys.argv[1]
        if kind not in {"docx", "pdf"}:
            raise ValueError("Choose Word or PDF export.")
        data = create_docx(content) if kind == "docx" else create_pdf(content)
        sys.stdout.buffer.write(data)
    except Exception as error:
        sys.stderr.write(str(error))
        sys.exit(1)
