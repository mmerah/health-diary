# iPhone shortcut: "Health Diary"

This shortcut reads Apple Health data and sends it to your diary. Then it opens the diary.
You make the shortcut one time, by hand, in the **Shortcuts** app.

## Before you start

You need:
- **Tailscale** on the iPhone, with **VPN On Demand** on. The shortcut cannot reach the diary without it.
- **The diary address**. In this guide it is `https://health-diary.<your-tailnet>.ts.net`. Use your own address.
- **The shortcut key**. In the diary, open **Profile → Settings → Apple Health sync**. Tap **Create key**. Copy the key.
- About **20 minutes**.

How to use variables:
- To put a variable in a field, tap the field. Then tap the variable in the bar above the keyboard.
- To use a property of a variable (for example *Start Date*), tap the variable in the field. Then select the property.
- To change the date format of a date variable, tap the variable in the field. Then set **Date Format**.

## Procedure

### 1. Create the shortcut

1. Open the **Shortcuts** app. Tap **+**.
2. Tap the name at the top. Tap **Rename**. Type `Health Diary`. Use exactly this name.
   The diary starts the shortcut by this name.

To add an action, type its name in the search field at the bottom. Tap the action. Keep the order of this procedure.

### 2. Date

3. **Date**: keep *Current Date*.
4. **Set Variable**: Variable Name `Now`. Input: *Date*.
5. **Format Date**
   - Date: *Now*. Date Format: **ISO 8601**. Include ISO 8601 Time: **off**.
6. **Set Variable**: Variable Name `Today`. Input: *Formatted Date*. The value is like `2026-10-15`.
7. **Adjust Date**
   - Tap **Add**. Select **Subtract**. Type `1`. Select **days**. Date: *Now*.
8. **Adjust Date**
   - Tap **Add**. Select **Get Start of Day**. Date: *Adjusted Date* (from step 7).
9. **Set Variable**: Variable Name `Since`. Input: *Adjusted Date* (from step 8). This is yesterday at 00:00.

### 3. Sleep

10. **Find Health Samples**
    - Type: **Sleep Analysis**. Start Date: **is between** *Since* and *Now*.
    - Limit: **off**.
11. **Repeat with Each**: Input *Health Samples*.
12. **Text** (inside the repeat). Type the line below. Each `[...]` is a property of *Repeat Item*:

    ```
    [Value]|[Start Date]|[End Date]|[Source]
    ```

    - For **Start Date** and **End Date**: Date Format **ISO 8601**, Include ISO 8601 Time **on**.
    - Do not type spaces around `|`.
13. **Combine Text** (after **End Repeat**): Input *Repeat Results*. Separator: **New Lines**.
14. **Set Variable**: Variable Name `Sleep`. Input: *Combined Text*.

A correct line is like `Core|2026-10-14T23:30:00+02:00|2026-10-15T01:00:00+02:00|Apple Watch`.
If your lines show other date text, the date format is wrong.

### 4. Steps

15. **Find Health Samples**
    - Type: **Steps**. Start Date: **is between** *Since* and *Now*.
    - Group By: **Day**. Limit: **off**.
16. **Repeat with Each**: Input *Health Samples*.
17. **Text** (inside the repeat). Use *Repeat Item*, with the same date format as step 12:

    ```
    [Value]|[Start Date]|[End Date]
    ```

18. **Combine Text** (after **End Repeat**): Input *Repeat Results*. Separator: **New Lines**.
19. **Set Variable**: Variable Name `Steps`. Input: *Combined Text*.

**Group By: Day** gives one total for each day. It does not count iPhone and Apple Watch steps two times.

### 5. Resting heart rate

20. Do steps 15 to 19 again, with these changes:
    - Type: **Resting Heart Rate**.
    - Group By: **None**. The diary calculates the average for each day.
    - Variable Name: `RestingHR`.

### 6. HRV

21. Do steps 15 to 19 again, with these changes:
    - Type: **Heart Rate Variability**.
    - Group By: **None**.
    - Variable Name: `HRV`.

### 7. Weight (optional)

Do this section only if a scale or an app writes your weight to Apple Health.

22. **Find Health Samples**
    - Type: **Weight**. Start Date: **is between** *Since* and *Now*.
    - Sort by: **Start Date**. Order: **Latest First**. Limit: **on**, **1**.
23. **Text**. Use the properties of *Health Samples* (from step 22). Type one space between them:

    ```
    [Value] [Unit]
    ```

24. **Set Variable**: Variable Name `Weight`. Input: *Text*. The value is like `76.9 kg` or `170 lb`.
25. **Text**. Type the property **Start Date** of *Health Samples* (from step 22).
    - Date Format **ISO 8601**, Include ISO 8601 Time **on**.
26. **Set Variable**: Variable Name `WeightDate`. Input: *Text*.

The unit is necessary. Without it, the diary reads the number as kg.
If there is no weight, the variables are empty and the diary ignores them.

### 8. Send

27. **Get Contents of URL**
    - URL: `https://health-diary.<your-tailnet>.ts.net/api/ingest/health`
    - Tap the arrow to show more settings.
    - Method: **POST**.
    - Headers: tap **Add new header**. Key: `Authorization`. Value: `Bearer`, one space, then your key.
      Example: `Bearer 3vQx...`. Do not type quotes.
    - Request Body: **JSON**. Tap **Add new field** for each row of this table:

    | Key | Type | Value (variable) |
    |---|---|---|
    | `date` | Text | *Today* |
    | `sleep` | Text | *Sleep* |
    | `steps_days` | Text | *Steps* |
    | `resting_hr_days` | Text | *RestingHR* |
    | `hrv_days` | Text | *HRV* |
    | `weight` | Text | *Weight* (only with section 7) |
    | `weight_date` | Text | *WeightDate* (only with section 7) |

    Type the keys exactly as shown. The diary refuses unknown keys.

### 9. Open the diary

28. **Open URLs**: `https://health-diary.<your-tailnet>.ts.net/`

### 10. Finish

29. Tap **Done**. Tap the shortcut to run it one time.
30. iOS asks for access to Health data. Allow all the data types in the list.
31. Add the shortcut to the Home Screen:
    - On the shortcut, tap **⋯**. Tap **ⓘ** (Details) at the bottom.
    - Tap **Add to Home Screen**. Tap **Add**.

Use this Home Screen icon to open the diary. Each tap sends new data, then opens the diary.

## Do a test

1. Add the action **Show Result** after **Get Contents of URL**. Input: *Contents of URL*.
2. Run the shortcut. Read the result. Then remove **Show Result**.

| Result | Meaning | What to do |
|---|---|---|
| `{"ok": true, "date": ...}` | The diary received the data. | Nothing. Open **Today**: the Apple Health card shows sleep and steps. |
| `401` / "Missing or wrong shortcut key" | The key is wrong or missing. | Check the header: `Bearer`, one space, the key. Or create a new key. |
| `400` / "Some values are not valid: ..." | The message names a wrong key or value. | Compare the request body with the table in step 27. *Today* must be like `2026-10-15`. |
| `400` / "Could not read the data" | `weight_date` is not ISO 8601. | Check the date format in step 25. |
| `429` / "Too many syncs" | More than 30 sends in 10 minutes. | Wait for the time in the message. |
| Network error, or no answer | The iPhone cannot reach the diary. | Turn on Tailscale. Check the address. |

**Profile → Settings → Apple Health sync** shows **Last data received** after each good send.

To test the diary without the iPhone, use a computer on your tailnet:

```sh
curl -X POST https://health-diary.<your-tailnet>.ts.net/api/ingest/health \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR-KEY' \
  -d '{"steps_days": "1234|2026-10-14T00:00:00+02:00|2026-10-15T00:00:00+02:00"}'
```

## Optional: sync automatically

The automation must not open the diary each time. Use a copy of the shortcut without **Open URLs**.

1. Touch and hold **Health Diary**. Tap **Duplicate**.
2. Rename the copy `Health Diary sync`. Remove the action **Open URLs**.
3. Tap **Automation** → **+** (or **New Automation**) → **Time of Day**.
4. Set the time (for example 21:00) and **Daily**. Select **Run Immediately**. Tap **Next**.
5. Select **Health Diary sync**.

iOS blocks Health data while the iPhone is locked. Then the automation sends nothing or stops. This does no harm. The next run sends the missing data.

## Fields that the diary accepts

All fields are optional. Use the type **Text** for all of them in Shortcuts. A "line" is `value|start|end`, and dates are ISO 8601 with time.

| Field | Format |
|---|---|
| `date` | `YYYY-MM-DD`. The day of the sync. Default: today on the server. |
| `sleep` | Lines `value\|start\|end\|source`. The diary uses the night that ends on `date`. |
| `steps_days` | Lines, one for each day. Updates `date` and up to 7 days before. |
| `resting_hr_days`, `hrv_days` | Lines. Each value goes to the day of its start date. The diary uses the average of each day. Up to 7 days before `date`. |
| `steps`, `steps_yesterday`, `resting_hr`, `hrv` | One number. Old format: use the `_days` fields. |
| `weight` | Number with unit: `76.9 kg`, `170 lb`, `12 st`. A number without unit is kg. |
| `weight_unit` | `kg`, `lb` or `st`. For a `weight` without unit. |
| `weight_date` | ISO 8601 date and time of the weight. The diary keeps each weight one time. |
| `workouts` | Lines `type\|start\|end`. |

Sleep values in English and French are accepted: Core/Principal, Deep/Profond, REM/Paradoxal, Awake/Éveillé, In Bed/Au lit, Asleep/Endormi.
Numbers can have a decimal comma (`46,7`), a unit (`46 ms`) and thousands separators (`2 140`, `12,345`).
The diary ignores values that are not possible (for example 500 000 steps).
A sync never changes a value that you corrected by hand in the diary.

## Troubleshooting

- **Sync now does not start the shortcut**: the shortcut name is not exactly `Health Diary`.
- **No data, no error**: in the Health app, tap your picture → **Apps** → **Shortcuts**. Turn on all the types.
- **Steps too high**: set **Group By: Day** in step 15.
- **Sleep or bedtime wrong**: set Date Format **ISO 8601** with time on Start Date and End Date (step 12).
- **Weight too high**: add `[Unit]` after `[Value]` in step 23.
- **Error at night or in the morning**: the iPhone was locked. Run the shortcut again with the iPhone unlocked.

Note: the action and option names are from iOS 18 and iOS 26 in English. They can be different in other iOS versions or languages.
