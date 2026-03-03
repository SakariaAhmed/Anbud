from io import BytesIO

from pypdf import PdfReader


def extract_text_from_pdf(contents: bytes) -> str:
    reader = PdfReader(BytesIO(contents))
    pages = [page.extract_text() or "" for page in reader.pages]
    return "\n\n".join(pages).strip()


def chunk_text(raw_text: str, chunk_size: int = 2400) -> list[str]:
    text = raw_text.strip()
    if not text:
        return []
    return [text[i : i + chunk_size] for i in range(0, len(text), chunk_size)]
