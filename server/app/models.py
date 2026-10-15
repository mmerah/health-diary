"""Request bodies. The server checks every body, so a broken or hostile client cannot store
values the app does not expect. Unknown top-level keys are refused; unknown nested keys are dropped."""
from datetime import date as Date
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints


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
    tag: Str(100) | None = None


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


class Drinks(Part):
    water: Annotated[int, Field(ge=0, le=50)] | None = None
    coffee: Annotated[int, Field(ge=0, le=50)] | None = None
    alcohol: Annotated[int, Field(ge=0, le=50)] | None = None


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
    drinks: Drinks = Drinks()
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


class Workout(Part):
    type: Str(100) = "Workout"
    minutes: MINUTES = 0
    start: HHMM | None = None


class DayHealth(Body):
    sleep: Sleep | None = None
    steps: Annotated[int, Field(ge=0, le=200_000)] | None = None
    restingHr: Annotated[int, Field(ge=20, le=250)] | None = None
    hrv: Annotated[int, Field(ge=1, le=400)] | None = None
    workouts: Annotated[list[Workout], Field(max_length=50)] = []
    source: Literal["apple", "manual"] = "manual"
    syncedAt: Str(40) | None = None
    edited: Annotated[list[Str(30)], Field(max_length=20)] = []


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


MeasurementIn = Annotated[WeightIn | BloodPressureIn | TemperatureIn, Field(discriminator="type")]


# ---------- iPhone shortcut

SHORT = Str(100) | float | None
LINES = Str(500_000) | Annotated[list[Str(1000)], Field(max_length=20_000)] | None


class Ingest(Body):
    """Shortcuts sends numbers as text ("2 140", "46,7"); health.py reads them."""
    date: DATE_OR_EMPTY | None = None
    sleep: LINES = None
    steps_days: LINES = None
    steps: SHORT = None
    steps_yesterday: SHORT = None
    resting_hr: SHORT = None
    resting_hr_days: LINES = None
    hrv: SHORT = None
    hrv_days: LINES = None
    weight: SHORT = None
    weight_unit: Str(20) | None = None
    weight_date: Str(50) | None = None
    workouts: LINES = None


# ---------- Documents

DocCategory = Literal["Blood test", "Cardiology", "Imaging", "Consultation letter", "Prescription",
                      "Hospital stay", "Vaccination", "Other"]
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
