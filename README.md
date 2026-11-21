# Mango Grader PWA

Tabs: **Overview** (your scans, saved only on this device) · **Ripeness** (camera, upload, live mode, model selector) · **Disease** (Month 1 design preview) · **Insights** (verified v1 results and model comparison). Sidebar on laptop, bottom tab bar on phone.

Installable web app (laptop + phone): take a photo with the camera or upload one, and get unripe / ripe / overripe with confidence. **Live mode** (camera → "Start live") predicts on the camera feed about once a second and shows the result over the video.

**How it works:** the app is only the front end. The photo is sent to the Gradio app from notebook cell J (running in Colab), which runs `mango_ripeness_v1.keras`. No model file is in this folder. Running the model inside the browser (TensorFlow.js / ONNX) is a Month 1 task; the export from Keras 3.13 is still untested.

## Put it online (GitHub Pages, free, HTTPS: needed for the camera on phones)

1. Sign in to github.com (create an account if you don't have one).
2. Click **+ → New repository**, name it e.g. `mango-pwa`, set it to **Public**, click **Create repository**.
3. Click **uploading an existing file**, then drag in **everything inside this `mango-pwa` folder** (`index.html`, `app.js`, `style.css`, `sw.js`, `manifest.webmanifest`, the `icons` folder). Click **Commit changes**.
4. Go to **Settings → Pages**. Under "Branch" choose **main** and **/ (root)**, click **Save**.
5. Wait 1–2 minutes. Your app is at `https://<your-username>.github.io/mango-pwa/`.

Never upload API keys or model/data files to the repository.

## Demo day checklist

1. 10–15 min before presenting: open the notebook in Colab (CPU runtime) and run **cell J**. Copy the new `https://xxxx.gradio.live` link.
2. Open your app link on the laptop → gear icon → paste the link → **Save & test** → it should say "Connected".
3. In the same dialog, scan the **QR code** with your phone: it opens the app with the model link already set.
4. On the phone: browser menu → **Add to Home screen / Install app** (iPhone: Share → Add to Home Screen).
5. Keep the Colab tab open while presenting. If the model goes offline, re-run cell J and paste the new link.
6. Backup: screenshots or a screen recording of the app working.

## Known limits (say these in the presentation)

- The model always picks one of three classes; it cannot detect disease/rot or reject non-mango photos.
- Overripe training data comes almost entirely from one orchard-video dataset, so overripe on other backgrounds is unreliable.
- Needs internet and a running Colab session (cell J).
