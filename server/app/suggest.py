"""Suggestions for a new document, from its text: category, date and title.

The app never applies them by itself: the user sees them and confirms. The rules are simple
keyword lists in English, French and German. Text is compared without accents and case.
"""
import re
import unicodedata
from datetime import date as Date
from datetime import timedelta

CATEGORIES = ["Blood test", "Cardiology", "Imaging", "Consultation letter", "Prescription",
              "Hospital stay", "Vaccination", "Other"]

# (keyword, weight). Keywords are written without accents, in lower case. A keyword matches whole words;
# a "*" at the end matches any ending (hemoglobin*).
KEYWORDS = {
    "Blood test": [
        ("cholesterol*", 3), ("hemoglobin*", 3), ("haemoglobin*", 3), ("hamoglobin*", 3), ("blutbild", 4),
        ("creatinin*", 3), ("ferritin*", 3), ("tsh", 2), ("nfs", 3), ("hemogramme", 4), ("glycemie", 3),
        ("glucose", 2), ("triglycerid*", 3), ("leucocyt*", 3), ("leukocyt*", 3), ("leukozyt*", 3), ("hematocrit*", 3),
        ("hamatokrit", 3), ("plaquettes", 2), ("platelets", 2), ("thrombozyt*", 3), ("crp", 2), ("hba1c", 3),
        ("bilan sanguin", 4), ("blood test", 4), ("laboratoire", 2), ("laboratory", 2), ("labor", 2),
        ("prise de sang", 4), ("prelevement", 2), ("vitamine d", 2), ("vitamin d", 2), ("ldl", 2), ("hdl", 2),
        ("mmol/l", 1), ("g/l", 1), ("µmol/l", 1),
    ],
    "Cardiology": [
        ("ecg", 4), ("ekg", 4), ("electrocardiogram*", 4), ("holter", 4), ("echocardiogra*", 5),
        ("echographie cardiaque", 5), ("echo cardiaque", 4), ("cardiolog*", 3), ("kardiolog*", 3), ("herz", 2),
        ("herzecho", 4), ("coronar*", 2), ("koronar*", 2), ("tension arterielle", 1), ("arrhythm*", 3),
        ("fibrillation", 3), ("epreuve d'effort", 4), ("stress test", 3), ("belastungs-ekg", 4),
    ],
    "Imaging": [
        ("irm", 4), ("mri", 4), ("mrt", 4), ("scanner", 3), ("ct", 2), ("tomodensitometrie", 4),
        ("radiographie", 4), ("radiologie", 3), ("radiology", 3), ("x-ray", 4), ("rontgen", 4),
        ("echographie", 4), ("ultrasound", 4), ("ultraschall", 4), ("sonographie", 3), ("mammographie", 4),
        ("mammogram*", 4), ("imagerie", 3), ("imaging", 3), ("scintigraphie", 4), ("pet", 1), ("doppler", 2),
    ],
    "Prescription": [
        ("ordonnance", 5), ("rezept", 5), ("prescription", 4), ("posologie", 4), ("dosierung", 3),
        ("comprime*", 2), ("tablet*", 2), ("tablette*", 2), ("gelule*", 2), ("matin et soir", 2),
        ("1-0-1", 2), ("1-0-0", 2), ("renouvelable", 3), ("qsp", 3),
    ],
    "Hospital stay": [
        ("compte rendu d'hospitalisation", 6), ("hospitalisation", 3), ("discharge summary", 6),
        ("discharge", 2), ("austrittsbericht", 6), ("entlassungsbericht", 6), ("entlassung*", 3),
        ("hospitalized", 3), ("admission", 2), ("lettre de sortie", 5), ("sejour", 2), ("aufenthalt", 2),
    ],
    "Vaccination": [
        ("vaccin*", 5), ("vaccine*", 5), ("vaccination", 5), ("impfung*", 5), ("impfausweis", 6),
        ("immunization", 5), ("rappel", 1), ("booster", 2), ("dose", 1),
    ],
    "Consultation letter": [
        ("cher confrere", 5), ("chere consoeur", 5), ("chers confreres", 5), ("dear dr", 5), ("dear doctor", 5),
        ("dear colleague", 5), ("sehr geehrte*", 4), ("liebe kollegin", 5), ("lieber kollege", 5),
        ("je vous remercie de m'avoir adresse", 6), ("thank you for referring", 6), ("consultation", 2),
        ("konsultation", 2), ("bien confraternellement", 5), ("mit freundlichen kollegialen grussen", 5),
    ],
}


def plain(text):
    """Lower case, without accents: 'Hémoglobine' -> 'hemoglobine'."""
    t = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in t if not unicodedata.combining(c)).lower().replace("ß", "ss")


def _pattern(word):
    tail = r"\w*" if word.endswith("*") else ""
    return re.compile(r"(?<!\w)" + re.escape(word.rstrip("*")) + tail + r"(?!\w)")


_PATTERNS = {cat: [(_pattern(w), n) for w, n in words] for cat, words in KEYWORDS.items()}


def category_scores(text):
    t = plain(text)
    return {cat: sum(n * min(len(p.findall(t)), 3) for p, n in pats) for cat, pats in _PATTERNS.items()}


def suggest_category(text):
    """The best category, or "Other" when no rule is clear (score under 4)."""
    scores = category_scores(text)
    best = max(scores, key=scores.get)
    return best if scores[best] >= 4 else "Other"


# ---------- Date

MONTHS = {
    # English, French, German (without accents), full and short
    "january": 1, "jan": 1, "janvier": 1, "janv": 1, "januar": 1, "janner": 1,
    "february": 2, "feb": 2, "fevrier": 2, "fevr": 2, "fev": 2, "februar": 2,
    "march": 3, "mar": 3, "mars": 3, "marz": 3, "maerz": 3,
    "april": 4, "apr": 4, "avril": 4, "avr": 4,
    "may": 5, "mai": 5,
    "june": 6, "jun": 6, "juin": 6, "juni": 6,
    "july": 7, "jul": 7, "juillet": 7, "juil": 7, "juli": 7,
    "august": 8, "aug": 8, "aout": 8,
    "september": 9, "sep": 9, "sept": 9, "septembre": 9,
    "october": 10, "oct": 10, "octobre": 10, "oktober": 10, "okt": 10,
    "november": 11, "nov": 11, "novembre": 11,
    "december": 12, "dec": 12, "decembre": 12, "dezember": 12, "dez": 12,
}
_MONTH_RE = "|".join(sorted(MONTHS, key=len, reverse=True))
DATE_PATTERNS = [
    # 2025-03-12
    (re.compile(r"(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)"), lambda m: (m[1], m[2], m[3])),
    # 12/03/2025, 12.03.2025, 12-03-2025, 12/03/25
    (re.compile(r"(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)"), lambda m: (m[3], m[2], m[1])),
    # 12 mars 2025, 12. Marz 2025, 1er mars 2025
    (re.compile(rf"(?<!\d)(\d{{1,2}})(?:er|\.)?\s+({_MONTH_RE})\.?\s+(\d{{4}})(?!\d)"), lambda m: (m[3], m[2], m[1])),
    # March 12, 2025
    (re.compile(rf"\b({_MONTH_RE})\.?\s+(\d{{1,2}}),?\s+(\d{{4}})(?!\d)"), lambda m: (m[3], m[1], m[2])),
]
# A date right after one of these words is probably the date of the document.
DATE_WORDS = re.compile(r"\b(date|dated|le|du|fait le|edite le|collected|collection|sampled|preleve|prelevement|"
                        r"datum|vom|report date|issued|received|recu le|examen du|untersuchung vom)\b")
# A date right after one of these is a date of birth: never the document date.
BIRTH_WORDS = re.compile(r"\b(ne|nee|naissance|dob|birth|born|geboren|geb|geburtsdatum|ddn)\b")


def _to_date(y, mo, d):
    y = int(y)
    y = y + 2000 if y < 100 else y
    mo = MONTHS.get(mo, 0) if not str(mo).isdigit() else int(mo)
    try:
        return Date(y, mo, int(d))
    except ValueError:
        return None


def find_dates(text):
    """[(date, position, near a date word, near a birth word)] in the order of the text."""
    t = plain(text)
    found = []
    for pattern, parts in DATE_PATTERNS:
        for m in pattern.finditer(t):
            d = _to_date(*parts(m))
            if d is None and pattern is DATE_PATTERNS[1][0]:
                d = _to_date(m[3], m[1], m[2])  # 03/12/2025 written the US way
            if d:
                # The nearest word before the date decides: "DOB 1975-04-02. Collected: 2026-08-30".
                before = t[max(0, m.start() - 30):m.start()]
                word = max(((x.end(), "date") for x in DATE_WORDS.finditer(before)), default=(-1, None))
                birth = max(((x.end(), "birth") for x in BIRTH_WORDS.finditer(before)), default=(-1, None))
                nearest = max(word, birth)[1]
                found.append((d, m.start(), nearest == "date", nearest == "birth"))
    return sorted(found, key=lambda x: x[1])


def suggest_date(text, today=None):
    """The most likely date of the document, or None."""
    today = today or Date.today()
    dates = [x for x in find_dates(text) if not x[3] and Date(1990, 1, 1) <= x[0] <= today + timedelta(days=1)]
    near_word = [x for x in dates if x[2]]
    if near_word:
        return near_word[0][0]
    recent = [x for x in dates if x[0] >= today - timedelta(days=730)]
    return recent[0][0] if recent else None


# ---------- Title

# Lines with these words are about the patient or the doctor (names, addresses): not a title.
PERSONAL = re.compile(r"\b(dr|docteur|doctor|prof|madame|monsieur|mme|mr|mrs|ms|herr|frau|patient|patiente|"
                      r"nom|name|prenom|vorname|adresse|address|tel|telephone|fax|email|e-mail|rue|strasse|"
                      r"ne|nee|geboren|dob|ipp|nir|avs|insurance|assurance|versicherung)\b")


# A line with a number and a unit or a range is a measurement ("Cholestérol 2,15 g/L (< 2,00)"), not a title.
VALUE = re.compile(r"\d[\d.,]*\s*(%|[a-zµ]{1,5}/[a-z]{1,3}|mmol|mg|g|ui|iu|ng|pg|ms|bpm|mmhg)\b"
                   r"|\(\s*[<>]?\s*\d|\d\s*[-–]\s*\d", re.I)
# A title names a document ("Bilan sanguin", "Compte rendu", "Befund"), not only a place ("Laboratoire Central").
DOC_NOUN = re.compile(r"\b(bilan|compte rendu|rapport|report|resultats?|results?|analyses?|examen|exam|ordonnance|"
                      r"prescription|rezept|befund|bericht|lettre|letter|certificat|certificate|summary|"
                      r"echocardiograph\w*|holter|ecg|ekg|irm|mri|scanner|radiograph\w*|echographie|"
                      r"ultrasound|ultraschall|vaccination|impfung|hospitalisation|austritt\w*)\b")
MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def suggest_title(text, category, doc_date):
    """A heading from the text that names the document ("Bilan sanguin du 12/03/2026"), or else
    "<category> · <date>". A heading must contain words of the category, name no person and not be a
    measurement line. "Other" with no heading gets no title: better none than a bad one."""
    pats = _PATTERNS.get(category, [])
    best, best_score = None, 0
    for line in (text or "").splitlines()[:40]:
        s = " ".join(line.split())
        letters = sum(c.isalpha() for c in s)
        if not (6 <= len(s) <= 60) or letters < 0.5 * len(s) or len(s.split()) < 2:
            continue
        p = plain(s)
        if PERSONAL.search(p) or "@" in s or re.search(r"\d{5,}", s) or VALUE.search(s) or not DOC_NOUN.search(p):
            continue
        score = sum(n for pat, n in pats if pat.search(p))
        if score > best_score:
            best, best_score = s[:80], score
    if best:
        return best
    if category == "Other" or not category:
        return None
    return f"{category} · {doc_date.day} {MONTH_ABBR[doc_date.month - 1]} {doc_date.year}" if doc_date else category


def suggest(text, today=None):
    """{category, date, title}, or None when there is no text."""
    if not (text or "").strip():
        return None
    category = suggest_category(text)
    d = suggest_date(text, today)
    return {"category": category, "date": d.isoformat() if d else None, "title": suggest_title(text, category, d)}
