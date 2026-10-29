# Cloudinary setup (all pictures and files)

## 1. Account and keys
1. Create a free Cloudinary account. On the dashboard copy **Cloud name**, **API Key**, **API Secret**.
2. Render (backend), Environment, add:
   - `CLOUDINARY_CLOUD_NAME`
   - `CLOUDINARY_API_KEY`
   - `CLOUDINARY_API_SECRET`
   Redeploy. No change is needed on Vercel.

## 2. One setting you must change (PDFs)
New Cloudinary accounts block delivery of PDF and ZIP files. In Cloudinary: **Settings, Security**, tick **Allow delivery of PDF and ZIP files**. Without this, patient PDFs upload but will not open.

## 3. How files are kept
| What | Where | Who can open it |
|---|---|---|
| Doctor photos, news covers | `lisa/public/...` (public) | Anyone. They appear on the website. Served resized and in WebP/AVIF. |
| Patient documents, radiology images and reports | `lisa/private/...` (type "authenticated") | Nobody from the plain link. The backend adds a signature only when it sends the record to someone already allowed to see it (the patient, or staff treating them). |

- The browser uploads straight to Cloudinary using a one-time signature from the backend. The secret key never reaches the browser.
- The server picks the folder, a random file name, the allowed file types and public or private. The browser cannot change them.
- Once Cloudinary is set up, a private field (documents, radiology image and report) only accepts a private file uploaded to your account. Pasted links, public files and other accounts' files are refused.
- Limits: 5 MB doctor photo, 8 MB news cover, 10 MB for documents and radiology files.

## 4. Things to know
- A signed private link does not expire. It is long and cannot be guessed, and it is made fresh on each request, but anyone you send it to can open it. Links that expire need Cloudinary's token-based access, which is a paid feature.
- Cloudinary does not read DICOM files. Upload JPG/PNG exports or a PDF report.
- Older records that hold an ordinary pasted link keep working and are not changed.
- `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` in `package.json` are not used by any code. You can remove them.
- Until the three keys are set, uploads show "File upload isn't set up yet" and pasted links are still accepted as before.
