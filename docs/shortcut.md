# iPhone shortcut: "Health Diary"

This shortcut reads Apple Health data and sends it to your diary. Then it opens the diary.

There are two ways to get it:
- **Install it in one tap** (5 minutes). See [Install the ready-made shortcut](#install-the-ready-made-shortcut).
- **Make it by hand** in the **Shortcuts** app (about 30 minutes). See [Make the shortcut by hand](#make-the-shortcut-by-hand).

## Before you start

You need:
- **Tailscale** on the iPhone, with **VPN On Demand** on. The shortcut cannot reach the diary without it.
- **The diary address**. In this guide it is `https://health-diary.<your-tailnet>.ts.net`. Use your own address.
- **The shortcut key**. In the diary, open **Profile → Settings → Apple Health sync**. Tap **Create key**. Copy the key.

Then allow the shortcut to send a lot of data at once. Without this, iOS stops the send with
"not allowed to share … Health items":
- Open **Settings → Apps → Shortcuts → Advanced** (older iOS: **Settings → Shortcuts → Advanced**).
- Turn on **Allow Sharing Large Amounts of Data**.

## Install the ready-made shortcut

1. On the iPhone, open this link: [Health Diary shortcut](https://www.icloud.com/shortcuts/f2959f3cd37e40f1850d6c8b5bda1bb1).
   If the link does not work, download [`Health Diary.shortcut`](Health%20Diary.shortcut) on the iPhone and open it.
2. Tap **Set Up Shortcut** (or **Add Shortcut**). Answer the two questions:
   - **Address of your diary**: `https://health-diary.<your-tailnet>.ts.net`. No `/` at the end.
   - **Shortcut key**: paste the key.
3. Check the name in the list: it must be exactly `Health Diary`. If iOS named it `Health Diary 1`,
   you already have a shortcut with that name. Delete or rename the old one, then rename the new one.
   The diary starts the shortcut by this name.
4. If you have an Apple Watch: open the shortcut and do [Count steps from one device](#count-steps-from-one-device).
5. Do [Finish](#12-finish) and [Do a test](#do-a-test).

The ready-made shortcut sends sleep, steps, resting heart rate, HRV, blood oxygen and respiratory rate.
It does not send weight. To add weight, do section [10. Weight](#10-weight-optional) and add its two fields
in step 33.

## Make the shortcut by hand

How to use variables:
- To put a variable in a field, tap the field. Then tap the variable in the bar above the keyboard.
  If it is not there, tap **Select Variable**.
- To use a property of a variable (for example *Start Date*), tap the variable in the field. Then select the property.
- To change the date format of a date variable, tap the variable in the field. Then set **Date Format**.

To add an action, type its name in the search field at the bottom. Tap the action. Keep the order of this procedure.

### 1. Create the shortcut

1. Open the **Shortcuts** app. Tap **+**.
2. Tap the name at the top. Tap **Rename**. Type `Health Diary`. Use exactly this name.
   The diary starts the shortcut by this name.

### 2. Address and key

3. **Text**: type your diary address, for example `https://health-diary.<your-tailnet>.ts.net`. No `/` at the end.
4. **Set Variable**: Variable Name `Server`. Input: *Text*.
5. **Text**: paste your shortcut key.
6. **Set Variable**: Variable Name `Key`. Input: *Text*.

### 3. Date

7. **Date**: keep *Current Date*.
8. **Set Variable**: Variable Name `Now`. Input: *Date*.
9. **Format Date**
   - Date: *Now*. Date Format: **ISO 8601**. Include ISO 8601 Time: **off**.
10. **Set Variable**: Variable Name `Today`. Input: *Formatted Date*. The value is like `2026-10-15`.
11. **Adjust Date**
    - Tap **Add**. Select **Subtract**. Type `1`. Select **days**. Date: *Now*.
12. **Adjust Date**
    - Tap **Add**. Select **Get Start of Day**. Date: *Adjusted Date* (from step 11).
13. **Set Variable**: Variable Name `Since`. Input: *Adjusted Date* (from step 12). This is yesterday at 00:00.
14. **Adjust Date**
    - Tap **Add**. Select **Add**. Type `1`. Select **days**. Date: *Now*.
15. **Set Variable**: Variable Name `Tomorrow`. Input: *Adjusted Date* (from step 14).

All the health searches use **Start Date is between *Since* and *Tomorrow***.
Do not use *Now* as the end: **is between** compares whole days, so *Now* leaves out all of today
(last night after midnight, today's steps).

### 4. Sleep

16. **Find Health Samples**
    - The action reads like a sentence: *Find Health Samples where Type is …*. Tap the type. Select **Sleep Analysis**.
    - Tap **Add Filter**. Set **Start Date** **is between** *Since* and *Tomorrow*.
    - Limit: **off**.
17. **Repeat with Each**: Input *Health Samples*. Shortcuts adds **End Repeat** below it.
18. **Text** (inside the repeat, between **Repeat with Each** and **End Repeat**). Type the line below.
    Each `[...]` is a property of *Repeat Item*:

    ```
    [Value]|[Start Date]|[End Date]|[Source]
    ```

    - For **Start Date** and **End Date**: Date Format **ISO 8601**, Include ISO 8601 Time **on**.
    - Do not type spaces around `|`.
19. **Combine Text** (after **End Repeat**): Input *Repeat Results*. Separator: **New Lines**.
20. **Set Variable**: Variable Name `Sleep`. Input: *Combined Text*.

A correct line is like `Core|2026-10-14T23:30:00+02:00|2026-10-15T01:00:00+02:00|Apple Watch`.
If your lines show other date text, the date format is wrong.

On some iOS versions **Source** is always empty: the line ends with `|`. The diary accepts this.
But then it cannot tell the iPhone and the Apple Watch apart. If you sleep with an Apple Watch,
let only the Watch record sleep: in the Health app, open **Browse → Sleep → Full Schedule & Options**.
Turn off **Track Sleep with iPhone**. Under **Browse → Sleep → Data Sources & Access**, other apps must not write sleep data.

### 5. Steps

21. **Find Health Samples**
    - Type: **Steps**. **Start Date** **is between** *Since* and *Tomorrow*.
    - Group By: **Day**. Fill Missing: **off**. Limit: **off**. Unit: **count**.
22. **Repeat with Each**: Input *Health Samples*.
23. **Text** (inside the repeat). Use *Repeat Item*, with the same date format as step 18:

    ```
    [Value]|[Start Date]|[End Date]
    ```

24. **Combine Text** (after **End Repeat**): Input *Repeat Results*. Separator: **New Lines**.
25. **Set Variable**: Variable Name `Steps`. Input: *Combined Text*.

**Group By: Day** gives one total for each day.
**Fill Missing** must be off: it sends 0 steps for a day without data.

#### Count steps from one device

If you have an iPhone and an Apple Watch, **Group By: Day** can add the steps of both devices:
the total is then about two times too high. To count only the Watch:

- In step 21, tap **Add Filter**. Set **Source** **is** your Apple Watch.

Steps that you take without the Watch are then not counted. A daily number from one device is
more useful than a number that is sometimes counted two times.

### 6. Resting heart rate

26. Do steps 21 to 25 again, with these changes:
    - Type: **Resting Heart Rate**. Unit: **count/min**.
    - Group By: **None**. The diary calculates the average for each day.
    - No Source filter: only the Apple Watch measures it.
    - Variable Name: `RestingHR`.

### 7. HRV

27. Do steps 21 to 25 again, with these changes:
    - Type: **Heart Rate Variability**. Unit: **ms**. Not seconds: the diary ignores `0.047`.
    - Group By: **None**.
    - Variable Name: `HRV`.

### 8. Oxygen (optional, Apple Watch)

Do this section only if your Apple Watch measures blood oxygen.

28. Do steps 21 to 25 again, with these changes:
    - Type: **Blood Oxygen** (or **Oxygen Saturation**). Unit: **%**.
    - Group By: **None**. The diary calculates the average and the lowest value for each day.
    - Variable Name: `Oxygen`.

### 9. Respiratory rate (optional, Apple Watch)

Do this section only if your Apple Watch measures your respiratory rate during sleep.

29. Do steps 21 to 25 again, with these changes:
    - Type: **Respiratory Rate**. Unit: **count/min**.
    - Group By: **None**.
    - Variable Name: `Breathing`.

### 10. Weight (optional)

Do this section only if a scale or an app writes your weight to Apple Health.

30. **Find Health Samples**
    - Type: **Weight**. **Start Date** **is between** *Since* and *Tomorrow*.
    - Sort by: **Start Date**. Order: **Latest First**. Limit: **on**, **1**.
31. **Text**. Use the properties of *Health Samples* (from step 30). Type one space between them:

    ```
    [Value] [Unit]
    ```

    Then **Set Variable**: Variable Name `Weight`. Input: *Text*. The value is like `76.9 kg` or `170 lb`.
32. **Text**. Type the property **Start Date** of *Health Samples* (from step 30).
    - Date Format **ISO 8601**, Include ISO 8601 Time **on**.

    Then **Set Variable**: Variable Name `WeightDate`. Input: *Text*.

The unit is necessary. Without it, the diary reads the number as kg.
If there is no weight, the variables are empty and the diary ignores them.

### 11. Send

33. **Get Contents of URL**
    - URL: insert the variable *Server*, then type `/api/ingest/health` right after it. No space.
    - Tap the arrow to show more settings.
    - Method: **POST**.
    - Headers: tap **Add new header**. Key: `Authorization`. Value: type `Bearer`, one space,
      then insert the variable *Key*. Do not type quotes.
    - Request Body: **JSON**. Tap **Add new field** for each row of this table:

    | Key | Type | Value (variable) |
    |---|---|---|
    | `date` | Text | *Today* |
    | `sleep` | Text | *Sleep* |
    | `steps_days` | Text | *Steps* |
    | `resting_hr_days` | Text | *RestingHR* |
    | `hrv_days` | Text | *HRV* |
    | `spo2_days` | Text | *Oxygen* (only with section 8) |
    | `respiratory_rate_days` | Text | *Breathing* (only with section 9) |
    | `weight` | Text | *Weight* (only with section 10) |
    | `weight_date` | Text | *WeightDate* (only with section 10) |

    Type the keys exactly as shown. The diary refuses unknown keys.
34. **Open URLs**: insert the variable *Server*.

### 12. Finish

35. Tap **Done**. Tap the shortcut to run it one time.
36. iOS asks for access to Health data. Allow all the data types in the list.
    iOS can also ask if the shortcut may share data with your diary address. Tap **Always Allow**.
37. Add the shortcut to the Home Screen:
    - Touch and hold the shortcut. Tap **Details** (or **ⓘ**).
    - Tap **Add to Home Screen**. Tap **Add**.

Use this Home Screen icon to open the diary. Each tap sends new data, then opens the diary.

## Do a test

1. Add the action **Show Content** after **Get Contents of URL**. Input: *Contents of URL*.
   On older iOS the action is called **Show Result**. **Quick Look** also works.
2. Run the shortcut. Read the result. Then remove **Show Content**.

To check one variable while you make the shortcut, put **Show Content** with that variable at the end, and run the shortcut.

| Result | Meaning | What to do |
|---|---|---|
| `{"ok": true, "date": ...}` | The diary received the data. | Check that `sleep` shows last night, with a `wake` time this morning. |
| `sleep` ends before midnight, no `steps` today | The searches end at *Now*. | Use *Tomorrow* as the end in every **Find Health Samples** (step 15). |
| "not allowed to share … Health items" | iOS blocks large sends. | Turn on **Allow Sharing Large Amounts of Data**. See [Before you start](#before-you-start). |
| `401` / "Missing or wrong shortcut key" | The key is wrong or missing. | Check the header: `Bearer`, one space, the key. Or create a new key. |
| `400` / "Some values are not valid: ..." | The message names a wrong key or value. | Compare the request body with the table in step 33. *Today* must be like `2026-10-15`. |
| `400` / "Could not read the data" | `weight_date` is not ISO 8601. | Check the date format in step 32. |
| `429` / "Too many syncs" | More than 30 sends in 10 minutes. | Wait for the time in the message. |
| Network error, or no answer | The iPhone cannot reach the diary. | Turn on Tailscale. Check the address. |

The result shows only the day of the sync. Values of the days before go to those days.

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

## Import your history

The shortcut sends yesterday and today. To get the older data one time:

1. On the iPhone, open the **Health** app. Tap your picture. Tap **Export All Health Data**. Save `export.zip` in **Files**.
2. In the diary, open **Profile → Settings → Apple Health sync → Import your history**. Select `export.zip`.

The import fills only empty days. It counts the steps of each hour from one device, so the iPhone and the Apple Watch are not counted two times.

The upload stops if the iPhone locks or you open another app. Keep the diary on the screen until you see the result.
With a large export (more than a few hundred MB), it is easier to copy `export.zip` to a computer and import it there, in the browser.

After the import, delete `export.zip`. It contains all your health data, and it is not encrypted.

## Fields that the diary accepts

All fields are optional. Use the type **Text** for all of them in Shortcuts. A "line" is `value|start|end`, and dates are ISO 8601 with time.

| Field | Format |
|---|---|
| `date` | `YYYY-MM-DD`. The day of the sync. Default: today on the server. |
| `sleep` | Lines `value\|start\|end\|source`. The source can be empty. The diary uses the night that ends on `date`. |
| `steps_days` | Lines, one for each day. Updates `date` and up to 7 days before. |
| `resting_hr_days`, `hrv_days` | Lines. Each value goes to the day of its start date. The diary uses the average of each day. Up to 7 days before `date`. |
| `spo2_days` | Lines. Blood oxygen, as `0.97`, `97` or `97 %`. The diary keeps the average and the lowest value of each day. Up to 7 days before `date`. |
| `respiratory_rate_days` | Lines. Breaths per minute. The diary uses the average of each day. Up to 7 days before `date`. |
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
- **No data for today, or the night stops at midnight**: the searches end at *Now*. Use *Tomorrow* (step 15).
- **Steps too high**: set **Group By: Day** in step 21. If they are still about two times too high, see [Count steps from one device](#count-steps-from-one-device).
- **Steps 0 on a day**: turn off **Fill Missing** in step 21.
- **Sleep too long**: the iPhone and the Apple Watch both record sleep, and **Source** is empty. See the note after step 20.
- **Sleep or bedtime wrong**: set Date Format **ISO 8601** with time on Start Date and End Date (step 18).
- **No HRV**: set the unit to **ms** in step 27.
- **Weight too high**: add `[Unit]` after `[Value]` in step 31.
- **Error at night or in the morning**: the iPhone was locked. Run the shortcut again with the iPhone unlocked.

Note: the action and option names are from iOS 18 and iOS 26 in English. They can be different in other iOS versions or languages.
