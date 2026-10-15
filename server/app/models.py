"""Request bodies. The server checks every body, so a broken or hostile client cannot store
values the app does not expect. Unknown top-level keys are refused; unknown nested keys are dropped."""
from datetime import date as Date
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Discriminator, Field, StringConstraints, Tag


def _real_date(s):
    if s:
        Date.fromisoformat(s)  # the pattern allows 2026-02-31; this does not
    return s


DATE = Annotated[str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}$"), AfterValidator(_real_date)]
DATE_OR_EMPTY = Annotated[str, StringConstraints(pattern=r"^(\d{4}-\d{2}-\d{2})?$"), AfterValidator(_real_date)]
HHMM = Annotated[str, StringConstraints(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")]
HHMM_OR_EMPTY = Annotated[str, StringConstraints(pattern=r"^(([01]\d|2[0-3]):[0-5]\d)?$")]
MINUTES = Annotated[int, Field(ge=0, le=1440)]


def Str(n):  # noqa: N802 (used like a type)
    return Annotated[str, StringConstraints(max_length=n)]


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Part(BaseModel):
    model_config = ConfigDict(extra="ignore")


# ---------- Accounts

class Setup(Body):
    code: Str(100)
    username: Str(100)
    password: Str(1024)


class Login(Body):
    username: Str(100)
    password: Str(1024)


class PasswordChange(Body):
    current: Str(1024)
    new: Str(1024)


class Password(Body):
    password: Str(1024)


class NewUser(Body):
    username: Str(100)
    password: Str(1024)
    isAdmin: bool = False


class AdminFlag(Body):
    isAdmin: bool


class PaperlessSettings(Body):
    token: Str(500) | None = None
    # Documents with ANY of these Paperless tags show in the diary.
    tags: Annotated[list[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]],
                    Field(max_length=20)] | None = None


# ---------- Profile and settings

class Medication(Part):
    id: Str(64) = ""
    name: Str(200) = ""
    dose: Str(100) = ""
    since: DATE_OR_EMPTY = ""
    until: DATE_OR_EMPTY = ""
    asNeeded: bool = False


class Profile(Body):
    name: Str(200) = ""
    dob: DATE_OR_EMPTY = ""
    sex: Literal["", "Male", "Female", "Intersex", "Prefer not to say"] = ""
    ethnicity: Str(100) = ""
    heightCm: Annotated[int, Field(ge=50, le=250)] | None = None
    conditions: Str(5000) = ""
    allergies: Str(5000) = ""
    surgeries: Str(5000) = ""
    familyHistory: Str(5000) = ""
    lifestyle: Str(5000) = ""
    medications: Annotated[list[Medication], Field(max_length=50)] = []
    v: int = 0


class Settings(Body):
    redactWords: Annotated[list[Str(100)], Field(max_length=300)] | None = None
    # Paperless ids are numbers; diary documents are "d12".
    excludedDocs: Annotated[list[int | Annotated[str, StringConstraints(pattern=r"^d\d{1,18}$")]],
                            Field(max_length=2000)] | None = None
    lastSync: Any = None  # set by the server only; ignored


# ---------- Day log

class Meal(Part):
    time: HHMM_OR_EMPTY = ""
    text: Str(2000) = ""


class Meals(Part):
    breakfast: Meal | None = None
    lunch: Meal | None = None
    dinner: Meal | None = None


CUSTOM_ID = r"^c_[a-z0-9]{2,24}$"  # the user's own items (catalog.py)
# Water, coffee, alcohol, and the user's own counters. An id of a deleted counter stays valid:
# old days keep their values.
DrinkKey = Annotated[str, StringConstraints(pattern=r"^(water|coffee|alcohol|c_[a-z0-9]{2,24})$")]
Drinks = Annotated[dict[DrinkKey, Annotated[int, Field(ge=0, le=999)] | None], Field(max_length=100)]


class MedTaken(Part):
    done: bool = False
    time: HHMM_OR_EMPTY = ""


class ExtraMed(Part):
    name: Str(200) = ""
    time: HHMM_OR_EMPTY = ""


class Meds(Part):
    taken: Annotated[dict[Str(64), MedTaken], Field(max_length=50)] = {}
    extra: Annotated[list[ExtraMed], Field(max_length=20)] = []


class Symptom(Part):
    name: Str(100) = ""
    severity: Literal[1, 2, 3] | None = None
    when: Literal["day", "periods", "time"] | None = None
    periods: Annotated[list[Literal["morning", "afternoon", "evening", "night"]], Field(max_length=4)] = []
    from_: HHMM_OR_EMPTY = Field("", alias="from")
    to: HHMM_OR_EMPTY = ""


class DayLog(Body):
    v: Literal[2] = 2
    meals: Meals = Meals()
    snacks: Annotated[list[Meal], Field(max_length=20)] = []
    drinks: Drinks = {}
    meds: Meds = Meds()
    activities: Str(5000) = ""
    symptoms: Annotated[list[Symptom], Field(max_length=30)] = []
    notes: Str(10000) = ""


# ---------- Day health (hand corrections)

class Nap(Part):
    start: HHMM
    end: HHMM
    minutes: MINUTES


class Sleep(Part):
    total: MINUTES | None = None
    deep: MINUTES | None = None
    rem: MINUTES | None = None
    core: MINUTES | None = None
    awake: MINUTES | None = None
    bed: HHMM | None = None
    wake: HHMM | None = None
    naps: Annotated[list[Nap], Field(max_length=10)] = []
    inBedOnly: bool = False


class HealthPatch(Body):
    """Hand corrections of a day's health data: only the changed fields. A value sets the field;
    null removes it (the next sync fills it again)."""
    sleep: Sleep | None = None
    steps: Annotated[int, Field(ge=0, le=200_000)] | None = None
    restingHr: Annotated[int, Field(ge=20, le=250)] | None = None
    hrv: Annotated[int, Field(ge=1, le=400)] | None = None
    spo2: Annotated[float, Field(ge=50, le=100)] | None = None
    spo2Min: Annotated[int, Field(ge=50, le=100)] | None = None
    respiratoryRate: Annotated[float, Field(ge=4, le=60)] | None = None


# ---------- Measurements

class _Measurement(Body):
    date: DATE
    time: HHMM_OR_EMPTY = ""
    source: Any = None  # always "manual" for a POST; a client cannot claim Apple data


class WeightIn(_Measurement):
    type: Literal["weight"]
    value: Annotated[float, Field(ge=20, le=300)]


class BloodPressure(Body):
    sys: Annotated[int, Field(ge=60, le=260)]
    dia: Annotated[int, Field(ge=30, le=160)]
    pulse: Annotated[int, Field(ge=20, le=220)] | None = None


class BloodPressureIn(_Measurement):
    type: Literal["bp"]
    value: BloodPressure


class TemperatureIn(_Measurement):
    type: Literal["temp"]
    value: Annotated[float, Field(ge=34, le=43)]


class CustomIn(_Measurement):
    """One of the user's own measurements (catalog). main.py checks the id and the range."""
    type: Annotated[str, StringConstraints(pattern=CUSTOM_ID)]
    value: Annotated[float, Field(allow_inf_nan=False)]


def _measurement_kind(v):
    t = v.get("type") if isinstance(v, dict) else getattr(v, "type", None)
    return t if t in ("weight", "bp", "temp") else "custom"


MeasurementIn = Annotated[
    Annotated[WeightIn, Tag("weight")] | Annotated[BloodPressureIn, Tag("bp")] | Annotated[TemperatureIn, Tag("temp")]
    | Annotated[CustomIn, Tag("custom")],
    Discriminator(_measurement_kind)]


# ---------- iPhone shortcut

SHORT = Str(100) | float | None
LINES = Str(500_000) | Annotated[list[Str(1000)], Field(max_length=20_000)] | None


class Ingest(Body):
    """Shortcuts sends numbers as text ("2 140", "46,7"); health.py reads them."""
    date: DATE_OR_EMPTY | None = None
    sleep: LINES = None
    steps_days: LINES = None
    resting_hr_days: LINES = None
    hrv_days: LINES = None
    spo2_days: LINES = None
    respiratory_rate_days: LINES = None
    weight: SHORT = None
    weight_unit: Str(20) | None = None
    weight_date: Str(50) | None = None
    workouts: LINES = None


# ---------- Documents

BUILT_IN_TYPES = ("Blood test", "Cardiology", "Imaging", "Consultation letter", "Prescription",
                  "Hospital stay", "Vaccination", "Other")
# A built-in type or one of the user's own (catalog). main.py checks it against the user's catalog.
DocCategory = Annotated[str, StringConstraints(min_length=1, max_length=60, strip_whitespace=True)]
TITLE = Annotated[str, StringConstraints(min_length=1, max_length=200, strip_whitespace=True)]


class DocumentUpload(Body):
    """The optional form fields sent with a file."""
    date: DATE | None = None
    title: TITLE | None = None
    category: DocCategory | None = None


class DocumentPatch(Body):
    """Only the fields sent change. For a Paperless document, null gives back the Paperless value.
    For a diary document, null category means "not set"."""
    date: DATE | None = None
    title: TITLE | None = None
    category: DocCategory | None = None


# ---------- The user's catalog (own symptoms, document types, measurements, counters)

ID = Annotated[str, StringConstraints(pattern=CUSTOM_ID)]
NUM = Annotated[float, Field(allow_inf_nan=False, ge=-1e9, le=1e9)]


def Name(n):  # noqa: N802 (used like a type)
    return Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=n)]


class CatalogDocTypes(Part):
    custom: Annotated[list[Str(60)], Field(max_length=60)] = []
    hidden: Annotated[list[Literal[BUILT_IN_TYPES[:-1]]], Field(max_length=7)] = []  # never "Other"


class CatalogMeasurement(Part):
    id: ID
    name: Name(60)
    unit: Str(20) = ""
    low: NUM | None = None
    high: NUM | None = None
    min: NUM | None = None
    max: NUM | None = None
    step: Annotated[float, Field(gt=0, le=1e6, allow_inf_nan=False)] | None = None
    hidden: bool = False


class CatalogCounter(Part):
    id: ID
    name: Name(40)
    one: Str(20) = ""
    many: Str(20) = ""
    hidden: bool = False


class Catalog(Body):
    v: int = 1
    symptoms: Annotated[list[Str(100)], Field(max_length=60)] | None = None
    docTypes: CatalogDocTypes = CatalogDocTypes()
    measurements: Annotated[list[CatalogMeasurement], Field(max_length=60)] = []
    counters: Annotated[list[CatalogCounter], Field(max_length=60)] = []
