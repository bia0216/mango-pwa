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
    settings: $("settings"), settingsBtn: $("settingsBtn"), serverInput: $("serverInput"), saveServerBtn: $("saveServerBtn"),
    settingsMsg: $("settingsMsg"), phoneBox: $("phoneBox"), qr: $("qr"), phoneLink: $("phoneLink"),
    installBtn: $("installBtn"), canvas: $("canvas"),
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
      setPill("ok", "Model online · " + new URL(server).host);
      return true;
    } catch (_) {
      setPill("bad", "Model server offline (tap to change link)");
      return false;
    }
  }

  async function predict(blob) {
    const fd = new FormData();
    fd.append("files", blob, "mango.jpg");
    const up = await timedFetch(server + "/gradio_api/upload", { method: "POST", body: fd }, 60000);
    if (!up.ok) throw new Error("Upload to the model server failed (" + up.status + ").");
    const paths = await up.json();

    const call = await timedFetch(server + "/gradio_api/call/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [{ path: paths[0], meta: { _type: "gradio.FileData" } }] }),
    }, 30000);
    if (!call.ok) throw new Error("The model server refused the request (" + call.status + ").");
    const { event_id } = await call.json();

    const res = await timedFetch(server + "/gradio_api/call/predict/" + event_id, {}, 120000);
    return parseSSE(await res.text());
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

  function renderResult(r) {
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
    el.resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
      renderResult(r);
      setPill("ok", "Model online · " + new URL(server).host);
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

  el.cameraBtn.addEventListener("click", openCamera);
  el.snapBtn.addEventListener("click", snap);
  el.flipBtn.addEventListener("click", async () => {
    facing = facing === "environment" ? "user" : "environment";
    stopCamera();
    await openCamera();
  });
  el.closeCamBtn.addEventListener("click", resetView);
  el.againBtn.addEventListener("click", () => { resetView(); window.scrollTo({ top: 0, behavior: "smooth" }); });

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

  checkServer();
})();
