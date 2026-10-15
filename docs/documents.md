# Documents

Keep your medical documents in **Records**: blood tests, reports, letters, prescriptions.
You can upload them, connect Paperless, or do both.

## Upload a document

1. Open **Records**. Tap **Add document**.
2. Select one or more files: PDF, JPEG, PNG or WebP. On an iPhone, you can also take a photo.
3. Optional: enter the date, the title and the type.
4. Tap **Upload**.

The limit is 200 MB and 300 pages for each document.

The app reads the text in the background:

- A PDF with text: the app reads the text directly.
- A scan or a photo: the app uses OCR in English, French and German. This takes a few seconds for
  each page.

The text goes into your reports. The report finds lab values in it, for example
"Cholesterol 2.15 g/L (< 2.00)".

## Check the type, date and title

The app suggests a type, a date and a title from the text. It never applies them without you.

1. Find the row **Check the details** on the document.
2. Tap **Confirm** to keep the suggestion, or **Change** to edit it.

To change a document later, tap **Edit**.

## Types

The built-in types are: Blood test, Cardiology, Imaging, Consultation letter, Prescription,
Hospital stay, Vaccination and Other.

To add your own types or hide built-in ones: **Profile → Settings → My lists → Document types**.

> **Note:** the AI report shows only the built-in types. It shows your own types as
> "Medical document", because your own words can contain names.

## Paperless

If you use [Paperless-ngx](https://docs.paperless-ngx.com/), Records also shows your Paperless
documents. You choose which tags to use. The default tag is `medical`.

1. The administrator sets `PAPERLESS_URL`. See [Settings](configuration.md#paperless).
2. Open **Profile → Settings → Paperless**.
3. Enter your Paperless API token. Tap **Save**.
4. Under **Tags to include**, select the tags of your medical documents.
   The diary shows every document that has at least one of these tags.

In the diary you can set a type, a date or a title for a Paperless document. The diary keeps your
change. Paperless does not change. To go back, tap **Use Paperless values** in the edit form.

## Reports

Each document has **Include in reports**. Clear it to leave a document out of all reports.
The report uses only documents that are ready (the text is read).

## Delete a document

Tap **Delete** on an uploaded document, then tap again to confirm. The file is deleted for good.
Paperless documents are not deleted from the diary: delete them in Paperless.
