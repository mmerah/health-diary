from datetime import date

import pytest

from app import suggest

TODAY = date(2026, 10, 15)


@pytest.mark.parametrize("text, category", [
    ("Hémoglobine 14,2 g/dL\nCréatinine 80 µmol/L\nFerritine 120", "Blood test"),
    ("Cholesterol total 5.2 mmol/L, HDL 1.4, LDL 3.1", "Blood test"),
    ("Kleines Blutbild: Leukozyten 6.2, Thrombozyten 250", "Blood test"),
    ("ECG de repos : rythme sinusal. Holter 24 h demandé.", "Cardiology"),
    ("Echocardiogram: normal left ventricular function", "Cardiology"),
    ("Échographie cardiaque transthoracique", "Cardiology"),
    ("IRM du genou droit : pas de lésion méniscale", "Imaging"),
    ("Échographie abdominale : foie normal", "Imaging"),
    ("Röntgen Thorax in zwei Ebenen", "Imaging"),
    ("Chest X-ray: no consolidation", "Imaging"),
    ("ORDONNANCE\nParacétamol 1 g, 1 comprimé matin et soir, QSP 5 jours", "Prescription"),
    ("Rezept: Ibuprofen 400 mg, Dosierung 1-0-1", "Prescription"),
    ("Compte rendu d'hospitalisation du 3 au 6 mars", "Hospital stay"),
    ("Discharge summary. The patient was hospitalized for 3 days.", "Hospital stay"),
    ("Austrittsbericht Innere Medizin", "Hospital stay"),
    ("Vaccin contre la grippe, lot AB123", "Vaccination"),
    ("Impfung gegen FSME, Impfausweis nachgetragen", "Vaccination"),
    ("Cher confrère,\nJe vous remercie de m'avoir adressé votre patiente.", "Consultation letter"),
    ("Dear Dr Smith, thank you for referring Mr Jones.", "Consultation letter"),
    ("Sehr geehrte Frau Kollegin, wir berichten über", "Consultation letter"),
    ("Invoice for parking, total 12 EUR", "Other"),
    ("", "Other"),
])
def test_category(text, category):
    assert suggest.suggest_category(text) == category


@pytest.mark.parametrize("text, expected", [
    ("Prélevé le 12/03/2026 à 08:10", date(2026, 3, 12)),
    ("Né le 01/02/1960\nDate du prélèvement : 05.09.2026", date(2026, 9, 5)),  # date of birth skipped
    ("DOB 1975-04-02. Collected: 2026-08-30", date(2026, 8, 30)),
    ("Datum: 3. März 2026", date(2026, 3, 3)),
    ("Paris, le 1er octobre 2026", date(2026, 10, 1)),
    ("Report date March 4, 2026", date(2026, 3, 4)),
    ("Some text 14/02/2026 and 20/02/2026", date(2026, 2, 14)),  # first plausible date
    ("Old result 12/03/2001, nothing else", None),  # no date word, and older than 2 years
    ("Date: 03/25/2026", date(2026, 3, 25)),  # written the US way
    ("Planned for 12/12/2027", None),  # future
    ("geb. 12.05.1980", None),
])
def test_date(text, expected):
    assert suggest.suggest_date(text, TODAY) == expected


def test_title_avoids_names_and_uses_the_category():
    text = "Dr Martin Dupont\n12 rue des Lilas 75011 Paris\nTél 01 23 45 67 89\nLaboratoire Central\n" \
           "Bilan sanguin du 12/03/2026\nPatient : Jean Durand"
    s = suggest.suggest(text, TODAY)
    assert s == {"category": "Blood test", "date": "2026-03-12", "title": "Bilan sanguin du 12/03/2026"}


def test_title_falls_back_to_category_and_date():
    assert suggest.suggest_title("ECG\n12", "Cardiology", date(2026, 1, 2)) == "Cardiology · 2 Jan 2026"
    # A measurement line is never a title, even with words of the category.
    lab = "LABORATOIRE CENTRAL\nCholestérol total 2,15 g/L (< 2,00) HAUT\nHémoglobine 14,1 g/dL (13,0 - 17,0)"
    assert suggest.suggest_title(lab, "Blood test", date(2026, 10, 2)) == "Blood test · 2 Oct 2026"
    assert suggest.suggest_title("12", "Other", None) is None
    assert suggest.suggest("   ") is None
