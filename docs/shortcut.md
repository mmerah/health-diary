# iPhone shortcut: "Health Diary"

The shortcut reads Apple Health, sends the data to your NAS, then opens the diary.
You make it once, by hand, in the **Shortcuts** app. It takes about 20 minutes.

Replace `health-diary.tailXXXX.ts.net` with your own address everywhere below.

> **The name must be exactly `Health Diary`.** The **Sync again** button in the app
> starts the shortcut by its name.

## Before you start

- In the diary, open **Profile → Apple Health sync → Create key**. Copy the key.
  Each user has their own key. It tells the server whose diary the data belongs to.
- Tailscale on the iPhone: turn on **VPN On Demand**, so the shortcut can reach the NAS.
- In Shortcuts, a "variable" is the result of an earlier action. To use one, tap the
  field, then pick it in the bar above the keyboard. To get a property (for example
  *Start Date*), tap the variable after you insert it.

## Actions, in order

### 1. Today's date

1. **Date** (leave it on *Current Date*).
2. **Format Date** → Date Format: **Custom** → `yyyy-MM-dd`.
3. **Set Variable** → name: `Today`.

### 2. Sleep (last night)

4. **Find Health Samples**
   - Type: **Sleep Analysis**
   - Filter: **Start Date** is in the last **2 days**
   - Sort by: **Start Date**, Oldest First
5. **Repeat with Each** (input: *Health Samples*). Inside the loop:
6. **Text**. Type exactly this, with the four variables from *Repeat Item*:

   ```
   [Value]|[Start Date]|[End Date]|[Source]
   ```

   For **Start Date** and **End Date**: tap the variable → Date Format: **ISO 8601**,
   and turn on **Include Time**.
7. After **End Repeat**: **Combine Text** (input: *Repeat Results*) with **New Lines**.
8. **Set Variable** → name: `Sleep`.

The server picks the best source when the iPhone and the Watch both recorded sleep.
English and French labels both work (Core / Principal, Deep / Profond, and so on).

### 3. Steps (yesterday and today)

9. **Find Health Samples**
   - Type: **Steps**
   - Filter: **Start Date** is in the last **2 days**
   - Group By: **Day**
10. **Repeat with Each**, then a **Text** with the same pattern as in step 6:
    `[Value]|[Start Date]|[End Date]`
11. **Combine Text** with **New Lines** → **Set Variable** → name: `Steps`.

"Group By Day" gives one total per day and removes double counts from the iPhone and the Watch.

### 4. Resting heart rate and HRV

12. **Find Health Samples** → Type: **Resting Heart Rate**, Sort by **Start Date**,
    **Latest First**, **Limit 1**. Then **Get Details of Health Sample** → **Value**.
    **Set Variable** → `RestingHR`.
13. **Find Health Samples** → Type: **Heart Rate Variability**, Filter: **Start Date is today**.
    Then **Calculate Statistics** → **Average**. **Set Variable** → `HRV`.

### 5. Weight (optional, if a scale writes to Apple Health)

14. **Find Health Samples** → Type: **Weight**, Filter: **Start Date** is in the last **1 days**,
    Sort by **Start Date**, **Latest First**, **Limit 1**.
15. **Get Details of Health Sample** → **Value** → **Set Variable** `Weight`.
16. Again on the same sample: **Get Details** → **Start Date** (ISO 8601, with time)
    → **Set Variable** `WeightDate`.

If no weight was recorded, these variables stay empty and the server ignores them.

### 6. Send to the NAS

17. **Get Contents of URL**
    - URL: `https://health-diary.tailXXXX.ts.net/api/ingest/health`
    - Method: **POST**
    - Headers: `Authorization` = `Bearer ` followed by your key (one space after *Bearer*)
    - Request Body: **JSON**, with these fields:

    | Key | Type | Value |
    |---|---|---|
    | `date` | Text | `Today` |
    | `sleep` | Text | `Sleep` |
    | `steps_days` | Text | `Steps` |
    | `resting_hr` | Text | `RestingHR` |
    | `hrv` | Text | `HRV` |
    | `weight` | Text | `Weight` |
    | `weight_date` | Text | `WeightDate` |

### 7. Open the diary

18. **Open URLs** → `https://health-diary.tailXXXX.ts.net/`

## Finish

- Name the shortcut **Health Diary**.
- Run it once by hand. iOS asks for access to Health data: allow all the types above.
- Tap the shortcut's **ⓘ** → **Add to Home Screen**. Use this icon to open the diary.
  Each tap syncs and then opens the app.

## Optional: sync during the day without opening anything

Shortcuts → **Automation** → **+** → **Time of Day** (for example 13:00 and 21:00)
→ **Run Immediately** → action **Run Shortcut: Health Diary**.
iOS blocks Health data while the phone is locked. If the phone is locked at that time,
this run fails without harm and the next one catches up.

## Check that it works

Open the diary: the Apple Health card on Today shows your sleep and steps, and
Profile shows "Last data received". A `401` answer means the key is wrong: create a new one.

If it fails, test the server from a terminal:

```sh
curl -X POST https://health-diary.tailXXXX.ts.net/api/ingest/health \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR-KEY' \
  -d '{"steps_days": "1234|2026-10-14T00:00:00+02:00|2026-10-15T00:00:00+02:00"}'
```

## What the server accepts

All fields are optional.

| Field | Format |
|---|---|
| `date` | `YYYY-MM-DD`. The day of the data. Default: today on the server. |
| `sleep` | Lines `value\|start\|end\|source`. Dates in ISO 8601. |
| `steps_days` | Lines `value\|start\|end` (one per day). Updates up to 7 days back. |
| `steps` | Number. Today's steps. |
| `resting_hr`, `hrv` | Numbers. `46,7` and `2 140` also work. |
| `weight`, `weight_date` | kg, and ISO 8601 date-time. The same weight is stored once. |
| `workouts` | Lines `type\|start\|end`. |

Values you corrected by hand in the app are never overwritten by a sync.
