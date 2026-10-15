"""Test files made from scratch: PDFs with text, scanned PDFs, password PDFs and images."""
import shutil
import subprocess
import tempfile
import zlib
from pathlib import Path

TOOLS = all(shutil.which(t) for t in ("pdfinfo", "pdftotext", "pdftoppm", "tesseract"))


def build_pdf(objects, trailer_extra=b""):
    """objects: the bodies of objects 1..n (object 1 is the catalog)."""
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root 1 0 R " % (len(objects) + 1) + trailer_extra + b">>\n"
    out += b"startxref\n%d\n%%%%EOF\n" % xref
    return bytes(out)


def _stream(data, extra=b""):
    return b"<< /Length %d " % len(data) + extra + b">>\nstream\n" + data + b"\nendstream"


def _esc(line):
    return line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)").encode("cp1252")


def text_pdf(pages, trailer_extra=b"", extra_objects=()):
    """A PDF with one page per text. Lines are separated by newlines. Accents work (WinAnsi)."""
    n = len(pages)
    kids = b" ".join(b"%d 0 R" % (4 + 2 * i) for i in range(n))
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [" + kids + b"] /Count %d >>" % n,
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"]
    for i, text in enumerate(pages):
        ops = b" ".join(b"(" + _esc(line) + b") Tj T*" for line in text.split("\n"))
        objs.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                    b"/Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>" % (5 + 2 * i))
        objs.append(_stream(b"BT /F1 16 Tf 60 740 Td 22 TL " + ops + b" ET"))
    return build_pdf(objs + list(extra_objects), trailer_extra)


def password_pdf():
    """A PDF that needs a user password (the standard security handler, with random keys)."""
    n = 6  # text_pdf with one page has objects 1..5
    enc = (b"<< /Filter /Standard /V 1 /R 2 /O <" + b"ab" * 32 + b"> /U <" + b"cd" * 32 + b"> /P -44 >>")
    return text_pdf(["Secret"], trailer_extra=b"/Encrypt %d 0 R /ID [<%s><%s>] " % (n, b"01" * 16, b"01" * 16),
                    extra_objects=[enc])


def render(pdf, fmt="png", dpi=200):
    """Renders page 1 with pdftoppm: png, jpeg, or pgm (gray, raw)."""
    with tempfile.TemporaryDirectory() as d:
        src = Path(d) / "in.pdf"
        src.write_bytes(pdf)
        flag = {"png": ["-png"], "jpeg": ["-jpeg"], "pgm": ["-gray"]}[fmt]
        subprocess.run(["pdftoppm", "-r", str(dpi), *flag, "-singlefile", str(src), str(Path(d) / "out")], check=True)
        ext = {"png": "png", "jpeg": "jpg", "pgm": "pgm"}[fmt]
        return (Path(d) / f"out.{ext}").read_bytes()


def scanned_pdf(text):
    """A PDF whose page is only an image of the text (like a scan): no text layer."""
    pgm = render(text_pdf([text]), "pgm", dpi=150)
    parts = pgm.split(b"\n", 3)  # P5, "w h", 255, data
    w, h = map(int, parts[1].split())
    image = _stream(zlib.compress(parts[3]), b"/Type /XObject /Subtype /Image /Width %d /Height %d "
                    b"/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode " % (w, h))
    return build_pdf([
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> "
        b"/Contents 5 0 R >>",
        image,
        _stream(b"q 612 0 0 792 0 0 cm /Im1 Do Q"),
    ])


def webp(text):
    from io import BytesIO

    from PIL import Image
    buf = BytesIO()
    Image.open(BytesIO(render(text_pdf([text]), "png"))).save(buf, "WEBP", quality=90)
    return buf.getvalue()
