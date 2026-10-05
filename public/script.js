let selectedFile = null;
let uploadedFilename = null;
let currentSessionId = null;
let pollInterval = null;

const uploadZone = document.getElementById("uploadZone");
const imageInput = document.getElementById("imageInput");
const previewContainer = document.getElementById("previewContainer");
const imagePreview = document.getElementById("imagePreview");
const metaRes = document.getElementById("metaRes");
const metaSize = document.getElementById("metaSize");
const metaRatio = document.getElementById("metaRatio");
const changeImageBtn = document.getElementById("changeImageBtn");
const phoneInput = document.getElementById("phoneNumber");
const startPairBtn = document.getElementById("startPairBtn");
const statusCard = document.getElementById("statusCard");
const statusStep = document.getElementById("statusStep");
const statusMessage = document.getElementById("statusMessage");
const codeBox = document.getElementById("codeBox");
const pairingCodeElem = document.getElementById("pairingCode");
const copyBtn = document.getElementById("copyBtn");
const copyToast = document.getElementById("copyToast");
const processStages = document.getElementById("processStages");

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

function calculateAspectRatio(width, height) {
  const divisor = gcd(width, height);
  const wRatio = width / divisor;
  const hRatio = height / divisor;
  if (wRatio > 50 || hRatio > 50) {
    return (width / height).toFixed(2) + ":1";
  }
  return `${wRatio}:${hRatio}`;
}

function handleFileSelection(file) {
  if (!file || !file.type.startsWith("image/")) {
    alert("Please select a valid image file (JPG, PNG, WebP).");
    return;
  }

  selectedFile = file;

  const reader = new FileReader();
  reader.onload = (e) => {
    imagePreview.src = e.target.result;

    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      const ratio = calculateAspectRatio(width, height);
      const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
      const sizeKB = (file.size / 1024).toFixed(1);
      const displaySize = file.size >= 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;

      metaRes.textContent = `${width} × ${height} px`;
      metaSize.textContent = displaySize;
      metaRatio.textContent = ratio;

      uploadZone.classList.add("hidden");
      previewContainer.classList.remove("hidden");
      validateForm();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

imageInput.addEventListener("change", (e) => {
  if (e.target.files && e.target.files[0]) {
    handleFileSelection(e.target.files[0]);
  }
});

uploadZone.addEventListener("click", () => imageInput.click());

uploadZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  uploadZone.classList.add("dragover");
});

uploadZone.addEventListener("dragleave", () => {
  uploadZone.classList.remove("dragover");
});

uploadZone.addEventListener("drop", (e) => {
  e.preventDefault();
  uploadZone.classList.remove("dragover");
  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
    handleFileSelection(e.dataTransfer.files[0]);
  }
});

changeImageBtn.addEventListener("click", () => {
  selectedFile = null;
  uploadedFilename = null;
  imageInput.value = "";
  previewContainer.classList.add("hidden");
  uploadZone.classList.remove("hidden");
  validateForm();
});

phoneInput.addEventListener("input", validateForm);

function validateForm() {
  const phone = phoneInput.value.replace(/[^0-9]/g, "");
  startPairBtn.disabled = !(selectedFile && phone.length >= 9);
}

function showToast(msg = "Copied to clipboard!") {
  copyToast.textContent = msg;
  copyToast.classList.add("show");
  setTimeout(() => copyToast.classList.remove("show"), 2000);
}

copyBtn.addEventListener("click", () => {
  const code = pairingCodeElem.textContent.trim();
  if (!code) return;
  navigator.clipboard.writeText(code.replace(/-/g, "")).then(() => {
    showToast("Pairing code copied!");
  }).catch(() => {
    navigator.clipboard.writeText(code);
    showToast("Copied!");
  });
});

function updateStageIndicator(step) {
  const stages = [
    "stage-connect",
    "stage-link",
    "stage-dp",
    "stage-logout",
    "stage-clean"
  ];

  let activeIndex = 0;
  if (step >= 1 && step <= 2) activeIndex = 0;
  else if (step === 3) activeIndex = 1;
  else if (step === 4 || step === 5) activeIndex = 2;
  else if (step === 6) activeIndex = 3;
  else if (step >= 7) activeIndex = 4;

  stages.forEach((id, idx) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("active", "completed");
    if (idx < activeIndex) el.classList.add("completed");
    else if (idx === activeIndex) el.classList.add("active");
  });
}

function startPolling(sessionId) {
  if (pollInterval) clearInterval(pollInterval);

  pollInterval = setInterval(async () => {
    try {
      const res = await fetch(`/connection/status?sessionId=${sessionId}`);
      const data = await res.json();

      if (data.message) {
        statusMessage.textContent = data.message;
      }
      if (data.step) {
        updateStageIndicator(data.step);
      }

      if (data.code) {
        pairingCodeElem.textContent = data.code;
        codeBox.classList.remove("hidden");
      }

      if (data.status === "completed" || data.status === "error") {
        clearInterval(pollInterval);
        startPairBtn.disabled = false;
        startPairBtn.textContent = "Start Over";
        startPairBtn.onclick = () => window.location.reload();
      }
    } catch (e) {
      console.warn("Status poll error:", e);
    }
  }, 1200);
}

startPairBtn.addEventListener("click", async () => {
  if (!selectedFile) return;

  const phone = phoneInput.value.replace(/[^0-9]/g, "");
  if (phone.length < 9) {
    alert("Please enter a valid phone number with country code.");
    return;
  }

  startPairBtn.disabled = true;
  startPairBtn.textContent = "Processing...";
  statusCard.classList.remove("hidden");
  processStages.classList.remove("hidden");
  statusStep.textContent = "INITIALIZING";
  statusMessage.textContent = "Uploading image to server...";
  updateStageIndicator(1);

  currentSessionId = "sess_" + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 6);

  try {
    const formData = new FormData();
    formData.append("image", selectedFile);

    const uploadRes = await fetch("/upload", {
      method: "POST",
      body: formData
    });

    const uploadData = await uploadRes.json();
    if (!uploadRes.ok || !uploadData.filename) {
      throw new Error(uploadData.error || "Failed to upload image.");
    }

    uploadedFilename = uploadData.filename;
    statusMessage.textContent = "Image uploaded! Connecting to WhatsApp...";

    startPolling(currentSessionId);

    const connUrl = `/connection?phoneNumber=${encodeURIComponent(phone)}&filename=${encodeURIComponent(uploadedFilename)}&sessionId=${encodeURIComponent(currentSessionId)}`;
    const connRes = await fetch(connUrl);
    const connData = await connRes.json();

    if (connData.code) {
      pairingCodeElem.textContent = connData.code;
      codeBox.classList.remove("hidden");
    }

  } catch (err) {
    statusStep.textContent = "ERROR";
    statusMessage.textContent = err.message || "Failed to start process.";
    startPairBtn.disabled = false;
    startPairBtn.textContent = "Try Again";
  }
});
