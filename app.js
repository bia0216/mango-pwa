(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const LS_KEY = "mango.server";
  const LOW_CONF = 0.6;          // below this, show a "low confidence" hint (UI choice, not from the model)
  const MAX_SIDE = 1024;         // photos are downscaled before upload (the model resizes to 224x224 anyway)
  const CLASS_INFO = {           // descriptions from the project's labeling rubric
    unripe:   { color: "var(--unripe)",   text: "Fully or almost fully green, firm and glossy." },
    ripe:     { color: "var(--ripe)",     text: "Mostly or fully yellow, smooth and plump." },
    overripe: { color: "var(--overripe)", text: "Wrinkled, soft or collapsing look, or heavy dark patches or bruising." },
  };

  const el = {
    pill: $("serverPill"), pillText: $("serverText"),
    stage: $("stage"), placeholder: $("placeholder"), video: $("video"), preview: $("preview"), busy: $("busy"),
    mainControls: $("mainControls"), cameraControls: $("cameraControls"),
    cameraBtn: $("cameraBtn"), fileInput: $("fileInput"), snapBtn: $("snapBtn"), flipBtn: $("flipBtn"), closeCamBtn: $("closeCamBtn"),
    error: $("error"), resultCard: $("resultCard"), verdictLabel: $("verdictLabel"), verdictConf: $("verdictConf"),
    verdictText: $("verdictText"), lowConf: $("lowConf"), bars: $("bars"), againBtn: $("againBtn"),
    aiDesc: $("aiDesc"), aiDescText: $("aiDescText"), gradeLink: $("gradeLink"),
    settings: $("settings"), settingsBtn: $("settingsBtn"), serverInput: $("serverInput"), saveServerBtn: $("saveServerBtn"),
    settingsMsg: $("settingsMsg"), phoneBox: $("phoneBox"), qr: $("qr"), phoneLink: $("phoneLink"),
    installBtn: $("installBtn"), canvas: $("canvas"),
    liveBtn: $("liveBtn"), liveTag: $("liveTag"), liveText: $("liveText"),
    modelRow: $("modelRow"), modelSelect: $("modelSelect"), modelUsed: $("modelUsed"),
  };

  // ---------- model server (the Gradio app from notebook cell J) ----------
  let server = "";
  try { server = localStorage.getItem(LS_KEY) || ""; } catch (_) { /* storage blocked */ }

  function normalizeServer(u) {
    u = (u || "").trim();
    if (!u) return "";
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    return new URL(u).origin;      // throws on an invalid URL
  }

  function saveServer(u) {
    server = normalizeServer(u);
    try { localStorage.setItem(LS_KEY, server); } catch (_) { /* ignore */ }
  }

  const params = new URLSearchParams(location.search);
  if (params.get("server")) {
    try { saveServer(params.get("server")); } catch (_) { /* ignore bad link */ }
    params.delete("server");
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
  }

  function setPill(state, text) {
    el.pill.dataset.state = state;
    el.pillText.textContent = text;
  }

  function timedFetch(url, opts = {}, ms = 30000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
  }

  async function checkServer() {
    if (!server) { setPill("none", "No model server set (tap to add)"); return false; }
    setPill("checking", "Connecting to model…");
    try {
      const r = await timedFetch(server + "/config", { cache: "no-store" }, 10000);
      if (!r.ok) throw new Error(String(r.status));
      let cfg = null;
      try { cfg = await r.json(); } catch (_) { /* old server: no model list */ }
      setupModels(cfg);
      setPill("ok", "Model online · " + new URL(server).host);
      return true;
    } catch (_) {
      setPill("bad", "Model server offline (tap to change link)");
      return false;
    }
  }

  // ---------- model selector (shown only when the server offers a "Model" dropdown, e.g. the comparison notebook) ----------
  const MODEL_KEY = "mango.model";
  let modelChoices = [];          // values the server accepts, e.g. ["MobileNetV2", "EfficientNetV2-B0", "YOLO26n-cls"]

  function setupModels(cfg) {
    const comp = cfg && Array.isArray(cfg.components)
      ? cfg.components.find((c) => c.type === "dropdown") : null;
    const raw = comp && comp.props && Array.isArray(comp.props.choices) ? comp.props.choices : [];
    // Gradio lists choices as ["Label", "value"] pairs (newer) or plain strings (older)
    const choices = raw.map((ch) => Array.isArray(ch) ? { label: String(ch[0]), value: String(ch[1] ?? ch[0]) }
                                                      : { label: String(ch), value: String(ch) });
    modelChoices = choices.map((c) => c.value);
    el.modelSelect.innerHTML = "";
    for (const c of choices) {
      const o = document.createElement("option");
      o.value = c.value;
      o.textContent = c.label;
      el.modelSelect.appendChild(o);
    }
    let saved = "";
    try { saved = localStorage.getItem(MODEL_KEY) || ""; } catch (_) { /* ignore */ }
    if (modelChoices.includes(saved)) el.modelSelect.value = saved;
    el.modelRow.hidden = modelChoices.length === 0;
  }

  el.modelSelect.addEventListener("change", () => {
    try { localStorage.setItem(MODEL_KEY, el.modelSelect.value); } catch (_) { /* ignore */ }
    el.resultCard.hidden = true;     // an old result belongs to the previous model
  });

  function currentModel() { return modelChoices.length ? el.modelSelect.value : ""; }

  async function predict(blob) {
    const fd = new FormData();
    fd.append("files", blob, "mango.jpg");
    const up = await timedFetch(server + "/gradio_api/upload", { method: "POST", body: fd }, 60000);
    if (!up.ok) throw new Error("Upload to the model server failed (" + up.status + ").");
    const paths = await up.json();
    lastUploadPath = paths[0];                         // reused by describe() so the photo is uploaded once

    const call = await timedFetch(server + "/gradio_api/call/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: modelChoices.length
        ? [{ path: paths[0], meta: { _type: "gradio.FileData" } }, currentModel()]   // photo + chosen model
        : [{ path: paths[0], meta: { _type: "gradio.FileData" } }] }),               // older one-model server
    }, 30000);
    if (!call.ok) throw new Error("The model server refused the request (" + call.status + ").");
    const { event_id } = await call.json();

    const res = await timedFetch(server + "/gradio_api/call/predict/" + event_id, {}, 120000);
    return parseSSE(await res.text());
  }

  let lastUploadPath = null;

  // Generic Gradio call: POST data, then read the "complete" event of the answer stream. Returns the data array or null.
  async function gradioCall(endpoint, data, ms = 60000) {
    const call = await timedFetch(server + "/gradio_api/call/" + endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }),
    }, 30000);
    if (!call.ok) return null;                       // e.g. 404: this server has no such endpoint
    const { event_id } = await call.json();
    const res = await timedFetch(server + "/gradio_api/call/" + endpoint + "/" + event_id, {}, ms);
    let event = null, out = null;
    for (const line of (await res.text()).split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:") && event === "complete") out = JSON.parse(line.slice(5).trim());
    }
    return out;
  }

  // ---------- disease + Grad-CAM + grade (all from OUR models on the server, cell 7) ----------
  const D_ORDER = ["healthy", "anthracnose", "stem_end_rot", "bacterial_canker"];
  const D_COLORS = { healthy: "var(--unripe)", anthracnose: "var(--danger)", stem_end_rot: "var(--overripe)", bacterial_canker: "#B784F5" };
  const GRADE_STYLE = {
    "Grade A": { badge: "A", cls: "g-a" }, "Grade B": { badge: "B", cls: "g-b" }, "Reject": { badge: "✕", cls: "g-x" },
    "Check by hand": { badge: "?", cls: "g-q" }, "No grade": { badge: "–", cls: "g-n" },
  };
  const d = {
    empty: $("dEmpty"), result: $("dResult"), msg: $("dMsg"), msgText: $("dMsgText"), cam: $("dCam"), photo: $("dPhoto"),
    toggle: $("dToggle"), label: $("dLabel"), conf: $("dConf"), bars: $("dBars"),
    badge: $("gBadge"), title: $("gTitle"), advice: $("gAdvice"), basis: $("gBasis"),
  };

  function diseaseMessage(text) {
    d.empty.hidden = true; d.result.hidden = true;
    d.msgText.textContent = text; d.msg.hidden = false;
  }

  function showGradeLink(g) {
    if (!el.gradeLink) return;
    const st = GRADE_STYLE[g.grade] || { badge: "", cls: "" };
    el.gradeLink.className = "grade-link " + st.cls;
    el.gradeLink.textContent = "";
    const b = document.createElement("b");
    b.textContent = st.badge;
    el.gradeLink.append(b, " " + g.grade + (g.name ? " · " + g.name : "") + "  ›  Disease tab");
    el.gradeLink.hidden = false;
  }

  async function checkDisease(label, photoUrl, scanId) {
    if (el.gradeLink) el.gradeLink.hidden = true;
    if (!lastUploadPath) return;
    d.empty.hidden = true; d.result.hidden = true;
    diseaseMessage("Checking for disease…");
    let out;
    try {
      out = await gradioCall("disease", [{ path: lastUploadPath, meta: { _type: "gradio.FileData" } }, label], 90000);
    } catch (_) { out = null; }
    const g = out && out[0];
    if (!g || g.available === false) {
      diseaseMessage("The model server has no disease model yet. In Colab, train it (mango_disease.ipynb, D3), then rerun cell 7 and paste the new link in Settings.");
      return;
    }
    showGradeLink(g);
    if (scanId) updateScan(scanId, { grade: g.grade, disease: g.disease || null, dconf: g.disease ? g.conf : null });
    d.msg.hidden = true;
    const st = GRADE_STYLE[g.grade] || { badge: "", cls: "" };
    d.badge.textContent = st.badge;
    d.badge.className = "grade-badge " + st.cls;
    d.title.textContent = g.grade;
    d.advice.textContent = g.advice || "";
    if (!g.disease) {                                  // not a mango: no disease check, no Grad-CAM
      d.result.hidden = false;
      d.label.textContent = "Not checked";
      d.label.style.color = "var(--muted)";
      d.conf.textContent = "";
      d.bars.innerHTML = "";
      d.basis.textContent = "The ripeness model says this is not a mango.";
      d.cam.removeAttribute("src"); d.photo.src = photoUrl; d.cam.hidden = true; d.photo.hidden = false; d.toggle.hidden = true;
      return;
    }
    d.label.textContent = g.name;
    d.label.style.color = D_COLORS[g.disease] || "var(--text)";
    d.conf.textContent = Math.round(g.conf * 100) + "% confident";
    d.basis.textContent = "Based on: ripeness " + g.ripeness + " + " + g.name.toLowerCase() + " (" + Math.round(g.conf * 100) + "%).";
    d.bars.innerHTML = "";
    for (const k of D_ORDER) {
      const v = (g.probs && g.probs[k]) || 0;
      const row = document.createElement("div");
      row.className = "bar-row";
      row.innerHTML = '<span class="name"></span><div class="bar-track"><div class="bar-fill"></div></div><span class="val"></span>';
      row.querySelector(".name").textContent = (g.names && g.names[k]) || k;
      row.querySelector(".val").textContent = (v * 100).toFixed(1) + "%";
      const fill = row.querySelector(".bar-fill");
      fill.style.background = D_COLORS[k];
      d.bars.appendChild(row);
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = (v * 100).toFixed(1) + "%"; }));
    }
    const cam = out[1];
    const camUrl = cam && (cam.url || (cam.path ? server + "/gradio_api/file=" + cam.path : ""));
    d.photo.src = photoUrl;
    if (camUrl) {
      d.cam.src = camUrl; d.cam.hidden = false; d.photo.hidden = true; d.toggle.hidden = false; d.toggle.textContent = "Show photo";
    } else {
      d.cam.hidden = true; d.photo.hidden = false; d.toggle.hidden = true;
    }
    d.result.hidden = false;
  }

  if (d.toggle) d.toggle.addEventListener("click", () => {   // guarded: an older cached index.html has no Disease tab
    const showCam = d.cam.hidden;
    d.cam.hidden = !showCam; d.photo.hidden = showCam;
    d.toggle.textContent = showCam ? "Show photo" : "Show heat map";
  });

  // Optional text description written by OpenAI on the server (cell 7). The grade itself always comes from our model.
  // Servers without a "describe" endpoint, or without an OpenAI key, simply return nothing and the box stays hidden.
  async function describe(label) {
    el.aiDesc.hidden = true;
    if (!lastUploadPath || !label) return;
    try {
      const call = await timedFetch(server + "/gradio_api/call/describe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: [{ path: lastUploadPath, meta: { _type: "gradio.FileData" } }, label] }),
      }, 30000);
      if (!call.ok) return;
      const { event_id } = await call.json();
      const res = await timedFetch(server + "/gradio_api/call/describe/" + event_id, {}, 60000);
      let event = null, text = "";
      for (const line of (await res.text()).split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:") && event === "complete") {
          const data = JSON.parse(line.slice(5).trim());
          text = (data && typeof data[0] === "string") ? data[0].trim() : "";
        }
      }
      if (!text) return;
      el.aiDescText.textContent = text.replace(/\*\*/g, "");   // plain text, never HTML
      el.aiDesc.hidden = false;
    } catch (_) { /* description is optional */ }
  }

  function parseSSE(text) {
    let event = null;
    for (const line of text.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        if (event === "complete") {
          const data = JSON.parse(line.slice(5).trim());
          if (!data || !data[0] || !data[0].confidences) throw new Error("The model returned no prediction.");
          return data[0];
        }
        if (event === "error") throw new Error("The model server reported an error while predicting.");
      }
    }
    throw new Error("No answer from the model server.");
  }

  // ---------- UI state ----------
  function showError(msg) { el.error.textContent = msg; el.error.hidden = !msg; }

  function resetView() {
    stopCamera();
    el.preview.hidden = true;
    el.preview.removeAttribute("src");
    el.placeholder.hidden = false;
    el.resultCard.hidden = true;
    el.busy.hidden = true;
    el.mainControls.hidden = false;
    el.cameraControls.hidden = true;
    showError("");
  }

  function renderResult(r, scroll = true) {
    if (el.aiDesc) el.aiDesc.hidden = true;          // an old description belongs to the previous photo
    if (el.gradeLink) el.gradeLink.hidden = true;
    el.modelUsed.textContent = currentModel() ? "Model: " + currentModel() : "";
    el.modelUsed.hidden = !currentModel();
    if (!(r.label in CLASS_INFO)) {                // "not a mango", or any answer that is not a ripeness class
      el.verdictLabel.textContent = "Not a mango";
      el.verdictLabel.style.color = "var(--danger)";
      el.verdictLabel.style.textTransform = "none";
      el.verdictConf.textContent = "";
      el.verdictText.textContent = "This photo doesn't look like a mango, so no ripeness is given. Take a close photo of one mango.";
      el.lowConf.hidden = true;
      el.bars.innerHTML = "";
      el.resultCard.hidden = false;
      if (scroll) el.resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    el.verdictLabel.style.textTransform = "";
    const conf = {};
    for (const c of r.confidences) conf[c.label] = c.confidence;
    const top = r.label;
    const p = conf[top] ?? 0;
    const info = CLASS_INFO[top] || { color: "var(--accent)", text: "" };

    el.verdictLabel.textContent = top;
    el.verdictLabel.style.color = info.color;
    el.verdictConf.textContent = Math.round(p * 100) + "% confident";
    el.verdictText.textContent = info.text;
    el.lowConf.hidden = p >= LOW_CONF;

    el.bars.innerHTML = "";
    for (const name of Object.keys(CLASS_INFO)) {
      const v = conf[name] ?? 0;
      const row = document.createElement("div");
      row.className = "bar-row";
      row.innerHTML = '<span class="name"></span><div class="bar-track"><div class="bar-fill"></div></div><span class="val"></span>';
      row.querySelector(".name").textContent = name;
      row.querySelector(".val").textContent = (v * 100).toFixed(1) + "%";
      const fill = row.querySelector(".bar-fill");
      fill.style.background = CLASS_INFO[name].color;
      el.bars.appendChild(row);
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = (v * 100).toFixed(1) + "%"; }));
    }
    el.resultCard.hidden = false;
    if (scroll) el.resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ---------- images ----------
  async function toJpeg(fileOrBlob) {
    let bmp;
    try {
      bmp = await createImageBitmap(fileOrBlob, { imageOrientation: "from-image" });
    } catch (_) {
      bmp = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("This file is not an image the browser can open."));
        img.src = URL.createObjectURL(fileOrBlob);
      });
    }
    const w = bmp.width, h = bmp.height;
    const s = Math.min(1, MAX_SIDE / Math.max(w, h));
    const c = el.canvas;
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    const g = c.getContext("2d");
    g.drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.92));
  }

  async function handleImage(fileOrBlob) {
    showError("");
    el.resultCard.hidden = true;
    let jpeg;
    try {
      jpeg = await toJpeg(fileOrBlob);
    } catch (e) {
      showError(e.message || "Could not read this image.");
      return;
    }
    el.preview.src = URL.createObjectURL(jpeg);
    el.preview.hidden = false;
    el.placeholder.hidden = true;

    if (!server) {
      pendingBlob = jpeg;
      openSettings("Add the model server link first. Your photo will be analysed right after.");
      return;
    }
    await analyse(jpeg);
  }

  let pendingBlob = null;

  async function analyse(jpeg) {
    el.busy.hidden = false;
    el.cameraBtn.disabled = true;
    try {
      const r = await predict(jpeg);
      setPill("ok", "Model online · " + new URL(server).host);
      try {                                          // a display problem must not look like "server offline"
        renderResult(r);
        const scanId = addScan(r);                   // saved on this device for the Overview tab
        const lbl = r.label in CLASS_INFO ? r.label : "not a mango";
        if (d.empty) checkDisease(lbl, el.preview.src, scanId).catch(() => {}).finally(() => describe(lbl));   // not awaited
      } catch (uiErr) {
        showError("The model answered (" + r.label + "), but the app could not show it: " + uiErr.message +
                  ". Reload the page; if it stays, upload ALL files from mango-pwa.zip again.");
      }
    } catch (e) {
      const offline = e.name === "AbortError" || e instanceof TypeError;
      showError(offline
        ? "Can't reach the model server. Is cell J still running in Colab? Its link changes on every run: paste the new one in Settings (gear icon)."
        : (e.message || "Something went wrong."));
      if (offline) setPill("bad", "Model server offline (tap to change link)");
    } finally {
      el.busy.hidden = true;
      el.cameraBtn.disabled = false;
    }
  }

  // ---------- camera ----------
  let stream = null;
  let facing = "environment";

  async function openCamera() {
    showError("");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      el.fileInput.click();          // e.g. not on HTTPS: fall back to the phone's own camera picker
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
    } catch (e) {
      showError("Camera not available (" + (e.name || "error") + "). Allow camera access, or use Upload photo.");
      return;
    }
    el.video.srcObject = stream;
    el.video.hidden = false;
    el.preview.hidden = true;
    el.placeholder.hidden = true;
    el.resultCard.hidden = true;
    el.mainControls.hidden = true;
    el.cameraControls.hidden = false;
    try { await el.video.play(); } catch (_) { /* autoplay quirks */ }
    try {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      el.flipBtn.hidden = cams.length < 2;
    } catch (_) { el.flipBtn.hidden = true; }
  }

  function stopCamera() {
    stopLive();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    el.video.srcObject = null;
    el.video.hidden = true;
  }

  async function snap() {
    const v = el.video;
    if (!v.videoWidth) return;
    const c = el.canvas;
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d").drawImage(v, 0, 0);
    const blob = await new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.92));
    stopCamera();
    el.mainControls.hidden = false;
    el.cameraControls.hidden = true;
    handleImage(blob);
  }

  // ---------- live mode: predict on camera frames continuously ----------
  let liveOn = false;
  const LIVE_SIDE = 640;          // frames are downscaled before upload to keep it fast
  const LIVE_PAUSE_MS = 400;      // pause between predictions (one request at a time)

  function frameBlob() {
    const v = el.video;
    if (!v.videoWidth) return Promise.resolve(null);
    const s = Math.min(1, LIVE_SIDE / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * s);
    c.height = Math.round(v.videoHeight * s);
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    return new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.85));
  }

  function showLive(r) {
    if (!(r.label in CLASS_INFO)) {
      el.liveTag.dataset.cls = "none";
      el.liveText.textContent = "Not a mango";
    } else {
      const c = r.confidences.find((x) => x.label === r.label);
      const pct = c ? Math.round(c.confidence * 100) : 0;
      el.liveTag.dataset.cls = r.label;
      el.liveText.textContent = r.label.charAt(0).toUpperCase() + r.label.slice(1) + " · " + pct + "%";
    }
    renderResult(r, false);
  }

  async function liveLoop() {
    while (liveOn && stream) {
      const blob = await frameBlob();
      if (blob) {
        try {
          const r = await predict(blob);
          if (!liveOn) break;
          showLive(r);
          setPill("ok", "Model online · " + new URL(server).host);
        } catch (e) {
          stopLive();
          showError("Live mode stopped: can't reach the model server. Is the Colab cell still running? Paste its new link in Settings if it changed.");
          setPill("bad", "Model server offline (tap to change link)");
          break;
        }
      }
      await new Promise((res) => setTimeout(res, LIVE_PAUSE_MS));
    }
  }

  function startLive() {
    if (!server) { openSettings("Add the model server link first, then start live mode."); return; }
    showError("");
    liveOn = true;
    el.liveBtn.textContent = "Stop live";
    el.liveBtn.classList.add("live-on");
    delete el.liveTag.dataset.cls;
    el.liveText.textContent = "Live · analysing…";
    el.liveTag.hidden = false;
    liveLoop();
  }

  function stopLive() {
    liveOn = false;
    el.liveBtn.textContent = "Start live";
    el.liveBtn.classList.remove("live-on");
    el.liveTag.hidden = true;
  }

  el.liveBtn.addEventListener("click", () => (liveOn ? stopLive() : startLive()));
  el.cameraBtn.addEventListener("click", openCamera);
  el.snapBtn.addEventListener("click", snap);
  el.flipBtn.addEventListener("click", async () => {
    const wasLive = liveOn;
    facing = facing === "environment" ? "user" : "environment";
    stopCamera();
    await openCamera();
    if (wasLive && stream) startLive();
  });
  el.closeCamBtn.addEventListener("click", resetView);
  el.againBtn.addEventListener("click", () => { resetView(); el.stage.scrollIntoView({ behavior: "smooth", block: "center" }); });

  el.fileInput.addEventListener("change", () => {
    const f = el.fileInput.files && el.fileInput.files[0];
    el.fileInput.value = "";
    if (f) handleImage(f);
  });

  // drag & drop and paste (handy on a laptop during the demo)
  ["dragenter", "dragover"].forEach((t) => el.stage.addEventListener(t, (e) => { e.preventDefault(); el.stage.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((t) => el.stage.addEventListener(t, (e) => { e.preventDefault(); el.stage.classList.remove("drag"); }));
  el.stage.addEventListener("drop", (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.type.startsWith("image/")) { stopCamera(); el.mainControls.hidden = false; el.cameraControls.hidden = true; handleImage(f); }
  });
  window.addEventListener("paste", (e) => {
    const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith("image/"));
    if (item) { stopCamera(); el.mainControls.hidden = false; el.cameraControls.hidden = true; handleImage(item.getAsFile()); }
  });

  // ---------- settings ----------
  function openSettings(msg) {
    el.serverInput.value = server;
    el.settingsMsg.textContent = msg || "";
    renderPhoneBox();
    if (typeof el.settings.showModal === "function") el.settings.showModal();
    else el.settings.setAttribute("open", "");
  }

  let qrLoading = null;
  function loadQrLib() {
    if (window.QRCode) return Promise.resolve();
    if (!qrLoading) {
      qrLoading = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
        s.onload = resolve;
        s.onerror = () => { qrLoading = null; reject(new Error("QR library failed to load")); };
        document.head.appendChild(s);
      });
    }
    return qrLoading;
  }

  async function renderPhoneBox() {
    if (!server) { el.phoneBox.hidden = true; return; }
    const link = location.origin + location.pathname + "?server=" + encodeURIComponent(server);
    el.phoneLink.href = link;
    el.phoneLink.textContent = link;
    el.phoneBox.hidden = false;
    el.qr.innerHTML = "";
    try {
      await loadQrLib();
      new window.QRCode(el.qr, { text: link, width: 180, height: 180, correctLevel: window.QRCode.CorrectLevel.M });
    } catch (_) {
      el.qr.textContent = "QR code unavailable offline. Use the link below.";
    }
  }

  el.settingsBtn.addEventListener("click", () => openSettings());
  el.pill.addEventListener("click", () => openSettings());
  el.saveServerBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      saveServer(el.serverInput.value);
    } catch (_) {
      el.settingsMsg.textContent = "That doesn't look like a valid link.";
      return;
    }
    el.settingsMsg.textContent = "Testing…";
    const ok = await checkServer();
    el.settingsMsg.textContent = ok ? "Connected. You're ready." : "Can't reach that link. Is cell J running in Colab?";
    renderPhoneBox();
    if (ok && pendingBlob) {
      const b = pendingBlob;
      pendingBlob = null;
      el.settings.close();
      analyse(b);
    }
  });

  // ---------- install (PWA) ----------
  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    el.installBtn.hidden = false;
  });
  el.installBtn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    el.installBtn.hidden = true;
  });
  window.addEventListener("appinstalled", () => { el.installBtn.hidden = true; });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
  }

  // ---------- scan history (kept only in this browser; feeds the Overview tab) ----------
  const HIST_KEY = "mango.history";
  const COLORS = { unripe: "#5BC27A", ripe: "#F2B42C", overripe: "#C9733A", "not a mango": "#9FB3A5" };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

  function loadScans() {
    try { return JSON.parse(localStorage.getItem(HIST_KEY) || "[]"); } catch (_) { return []; }
  }
  function saveScans(s) {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(s.slice(-200))); } catch (_) { /* storage blocked */ }
  }
  // batches: a sorter starts a batch, scans its mangoes, then downloads a report
  const BATCH_KEY = "mango.batch";
  function currentBatch() {
    let b = null;
    try { b = JSON.parse(localStorage.getItem(BATCH_KEY) || "null"); } catch (_) { /* ignore */ }
    if (!b || !b.id) {
      b = { id: 1, started: Date.now() };
      try { localStorage.setItem(BATCH_KEY, JSON.stringify(b)); } catch (_) { /* ignore */ }
    }
    return b;
  }
  function newBatch() {
    const b = { id: currentBatch().id + 1, started: Date.now() };
    try { localStorage.setItem(BATCH_KEY, JSON.stringify(b)); } catch (_) { /* ignore */ }
    return b;
  }

  function addScan(r) {
    const known = r.label in CLASS_INFO;
    const c = known ? (r.confidences.find((x) => x.label === r.label) || {}).confidence : null;
    const s = loadScans();
    const t = Date.now();
    s.push({ t, label: known ? r.label : "not a mango", conf: c ?? null, model: currentModel(), batch: currentBatch().id });
    saveScans(s);
    return t;                                        // id of this scan, used to add the disease result later
  }
  function updateScan(t, patch) {
    const s = loadScans();
    const x = s.find((y) => y.t === t);
    if (!x) return;
    Object.assign(x, patch);
    saveScans(s);
    renderOverview();
  }
  function ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    return h < 24 ? h + " h ago" : Math.round(h / 24) + " d ago";
  }

  const GRADE_COLORS = { "Grade A": "#5BC27A", "Grade B": "#F2B42C", "Reject": "#FF8A6B", "Check by hand": "#C9D6CC",
                         "No grade": "#6F8576", "Not graded": "rgba(255,255,255,.22)" };
  let donutMode = "grade";
  const gradeOf = (x) => x.grade || "Not graded";     // older scans and scans without a disease server have no grade
  function gradeBadge(g) {
    const st = GRADE_STYLE[g];
    return st ? `<b class="mini-badge ${st.cls}" title="${esc(g)}">${st.badge}</b>` : "";
  }

  function renderBatch(s) {
    const b = currentBatch();
    const mine = s.filter((x) => x.batch === b.id);
    $("batchName").textContent = "Batch " + b.id;
    $("batchCount").textContent = mine.length + (mine.length === 1 ? " mango" : " mangoes");
    const parts = ["Grade A", "Grade B", "Reject", "Check by hand"].map((g) => [g, mine.filter((x) => x.grade === g).length]).filter(([, n]) => n);
    $("batchGrades").textContent = "Started " + new Date(b.started).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
      + (parts.length ? " · " + parts.map(([g, n]) => g.replace("Grade ", "") + " " + n).join(" · ") : "");
    $("reportBtn").disabled = !mine.length;
  }

  function csvCell(v) {
    const t = v == null ? "" : String(v);
    return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }
  function downloadReport() {
    const b = currentBatch();
    const mine = loadScans().filter((x) => x.batch === b.id);
    if (!mine.length) return;
    const head = ["batch", "time", "ripeness", "ripeness_confidence", "disease", "disease_confidence", "grade", "model"];
    const rows = mine.map((x) => [b.id, new Date(x.t).toLocaleString(), x.label, x.conf != null ? x.conf.toFixed(3) : "",
      x.disease || "", x.dconf != null ? x.dconf.toFixed(3) : "", x.grade || "Not graded", x.model || ""]);
    const csv = [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `mango-batch-${b.id}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function renderOverview() {
    const s = loadScans();
    const last = s[s.length - 1];
    $("lastLabel").textContent = last ? cap(last.label) + (last.conf != null ? " · " + Math.round(last.conf * 100) + "%" : "") : "No scans yet";
    $("lastLabel").style.color = last ? COLORS[last.label] : "";
    $("lastMeta").textContent = last ? (last.grade ? last.grade + " · " : "") + (last.model ? last.model + " · " : "") + ago(last.t) : "Scan a mango to see it here.";
    renderBatch(s);

    // donut: your scans by grade (default) or by ripeness
    const colors = donutMode === "grade" ? GRADE_COLORS : COLORS;
    const keyOf = donutMode === "grade" ? gradeOf : (x) => x.label;
    const keys = Object.keys(colors).filter((k) => k !== "Not graded" || s.some((x) => !x.grade));
    const counts = keys.map((k) => s.filter((x) => keyOf(x) === k).length);
    const total = counts.reduce((a, b) => a + b, 0);
    const C = 2 * Math.PI * 60;
    let off = 0;
    let svg = '<g transform="rotate(-90 75 75)" fill="none" stroke-width="16"><circle cx="75" cy="75" r="60" stroke="rgba(255,255,255,.08)"/>';
    keys.forEach((k, i) => {
      if (!counts[i]) return;
      const len = counts[i] / total * C;
      svg += `<circle cx="75" cy="75" r="60" stroke="${colors[k]}" stroke-dasharray="${len.toFixed(1)} ${(C - len).toFixed(1)}" stroke-dashoffset="${(-off).toFixed(1)}"/>`;
      off += len;
    });
    svg += `</g><text x="75" y="76" text-anchor="middle" fill="#EAF1EC" font-family="Space Grotesk, sans-serif" font-size="28" font-weight="700">${total}</text>`
         + '<text x="75" y="96" text-anchor="middle" fill="#9FB3A5" font-family="Inter, sans-serif" font-size="11">scans</text>';
    $("donut").innerHTML = svg;
    $("donutLegend").innerHTML = keys.map((k, i) => `<li><i style="background:${colors[k]}"></i>${cap(k)} <b>${counts[i]}</b></li>`).join("");

    // bars: scans per day, last 7 days
    const days = [];
    for (let d = 6; d >= 0; d--) {
      const day = new Date();
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - d);
      days.push(day.getTime());
    }
    const per = days.map((d0) => s.filter((x) => x.t >= d0 && x.t < d0 + 864e5).length);
    const max = Math.max(1, ...per);
    $("weekBars").innerHTML = days.map((d0, i) =>
      `<div class="day"><span>${per[i] || ""}</span><div class="bar${i === 6 ? " today" : ""}" style="height:${Math.round(per[i] / max * 72)}%"></div>`
      + `<span>${new Date(d0).toLocaleDateString(undefined, { weekday: "short" })}</span></div>`).join("");

    // recent scans
    const rec = s.slice(-5).reverse();
    $("recentList").innerHTML = rec.length
      ? rec.map((x) => `<li><span class="rec-main">${gradeBadge(x.grade)}<span style="color:${COLORS[x.label]}">${cap(x.label)}</span></span><span class="meta">`
          + `${x.conf != null ? Math.round(x.conf * 100) + "% · " : ""}${x.model ? esc(x.model) + " · " : ""}${ago(x.t)}</span></li>`).join("")
      : '<li><span class="muted">No scans yet</span></li>';
  }

  function setDonutMode(m) {
    donutMode = m;
    $("segGrade").classList.toggle("on", m === "grade");
    $("segRipe").classList.toggle("on", m !== "grade");
    $("segGrade").setAttribute("aria-pressed", String(m === "grade"));
    $("segRipe").setAttribute("aria-pressed", String(m !== "grade"));
    renderOverview();
  }
  $("segGrade").addEventListener("click", () => setDonutMode("grade"));
  $("segRipe").addEventListener("click", () => setDonutMode("ripeness"));
  $("reportBtn").addEventListener("click", downloadReport);
  $("newBatchBtn").addEventListener("click", () => {
    const n = loadScans().filter((x) => x.batch === currentBatch().id).length;
    if (n && !confirm(`Start a new batch? Batch ${currentBatch().id} (${n} mangoes) stays in the history; download its report first if you need it.`)) return;
    const b = newBatch();
    $("batchMsg").textContent = "Batch " + b.id + " started. New scans are counted here.";
    $("batchMsg").hidden = false;
    renderOverview();
  });

  $("clearHistory").addEventListener("click", () => {
    if (confirm("Clear the scan history on this device?")) { saveScans([]); renderOverview(); }
  });

  // ---------- tabs: Overview · Ripeness · Disease · Insights (sidebar on laptop, bottom bar on phone) ----------
  const TABS = ["overview", "ripeness", "disease", "insights"];
  function showTab(name, updateHash = true) {
    if (!TABS.includes(name)) name = "overview";
    document.querySelectorAll(".view").forEach((v) => { v.hidden = v.dataset.view !== name; });
    document.querySelectorAll("[data-tab]").forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle("active", on);
      if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    if (name !== "ripeness" && stream) {           // leaving the scan tab turns the camera off
      stopCamera();
      el.mainControls.hidden = false;
      el.cameraControls.hidden = true;
      if (el.preview.hidden) el.placeholder.hidden = false;
    }
    if (name === "overview") renderOverview();
    if (updateHash && location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
    window.scrollTo({ top: 0 });
  }
  document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.goto)));
  window.addEventListener("hashchange", () => showTab(location.hash.slice(1), false));

  // Overview quick actions jump to the scan tab
  document.querySelectorAll("[data-quick]").forEach((b) => b.addEventListener("click", async () => {
    showTab("ripeness");
    if (b.dataset.quick === "upload") { el.fileInput.click(); return; }
    await openCamera();
    if (b.dataset.quick === "live" && stream) startLive();
  }));

  showTab(location.hash.slice(1) || "overview", false);
  checkServer();
})();
