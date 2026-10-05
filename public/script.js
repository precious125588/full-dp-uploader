const $ = (id) => document.getElementById(id);
const dropZone = $('dropZone'), imageInput = $('imageInput'), preview = $('preview'), dropHint = $('dropHint');
const resultBox = $('result'), pairingBox = $('pairingBox'), pairingCodeEl = $('pairingCode');
const monitor = $('monitor'), statusMsg = $('statusMsg'), statusMsgText = $('statusMsgText'), cta = $('submitBtn'), ctaText = $('ctaText');
const copyBtn = $('copyBtn'), copyText = $('copyText'), pipelineFill = $('pipelineFill');

// ---------- Image preview ----------
dropZone.addEventListener('click', () => imageInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('drag');
    if (e.dataTransfer.files.length) { imageInput.files = e.dataTransfer.files; showPreview(); }
});
imageInput.addEventListener('change', showPreview);

function showPreview() {
    const file = imageInput.files[0];
    if (!file) return;
    preview.innerHTML = '';
    const reader = new FileReader();
    reader.onload = e => {
        const img = document.createElement('img');
        img.src = e.target.result;
        preview.appendChild(img);
        preview.classList.remove('hidden');
        dropHint.classList.add('hidden');
    };
    reader.readAsDataURL(file);
}

// ---------- Animated stage pipeline ----------
const TOTAL_STEPS = 7;
function setStep(step) {
    document.querySelectorAll('#pipeline .stage').forEach(el => {
        const n = Number(el.dataset.step);
        el.classList.toggle('done', n < step);
        el.classList.toggle('active', n === step);
    });
    const pct = Math.min(100, Math.max(6, (step / TOTAL_STEPS) * 100));
    pipelineFill.style.width = pct + '%';
}

// ---------- Live status polling ----------
let pollTimer = null;
function startPolling(sessionId) {
    monitor.classList.remove('hidden');
    setStep(1);
    statusMsgText.textContent = 'Starting session...';
    let last = '';
    pollTimer = setInterval(async () => {
        try {
            const r = await fetch(`/connect/status?sessionId=${encodeURIComponent(sessionId)}`);
            const d = await r.json();
            if (d.message && d.message !== last) {
                last = d.message;
                if (d.step) setStep(d.step);
                statusMsgText.textContent = d.message;
                // Hide the spinner when the run finished or failed
                if (d.status === 'completed' || d.status === 'error' || d.status === 'logged_out') {
                    statusMsg.classList.add('settled');
                }
                if (d.status === 'completed') stopPolling();
            }
        } catch (_) {}
    }, 1500);
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
function resetCta() { cta.disabled = false; ctaText.textContent = 'Generate Pairing Code'; }

// ---------- Copy pairing code ----------
copyBtn.addEventListener('click', async () => {
    const raw = pairingCodeEl.textContent.trim();
    if (!raw || raw.includes('----')) return;
    try {
        await navigator.clipboard.writeText(raw.replace(/-/g, ''));
        copyText.textContent = 'Copied!';
    } catch (_) {
        // Fallback for browsers without clipboard API
        const ta = document.createElement('textarea');
        ta.value = raw.replace(/-/g, '');
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); copyText.textContent = 'Copied!'; } catch (_) {}
        document.body.removeChild(ta);
    }
    copyBtn.classList.add('copied');
    setTimeout(() => { copyText.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 2000);
});

// ---------- Submit flow ----------
$('uploadForm').addEventListener('submit', async e => {
    e.preventDefault();
    stopPolling();
    const number = $('numberInput').value.trim();
    const image = imageInput.files[0];
    resultBox.innerHTML = '';
    pairingBox.classList.add('hidden');
    monitor.classList.add('hidden');
    statusMsg.classList.remove('settled');

    if (!number || !image) {
        resultBox.innerHTML = `<span class="err">Please provide both your number and an image.</span>`;
        return;
    }

    cta.disabled = true;
    ctaText.textContent = 'Uploading image…';

    try {
        const formData = new FormData();
        formData.append('image', image);
        const uploadRes = await fetch('/upload', { method: 'POST', body: formData });
        const uploadData = await uploadRes.json();

        if (!uploadData.filename) {
            resultBox.innerHTML = `<span class="err">Image upload failed. Try again.</span>`;
            resetCta();
            return;
        }

        ctaText.textContent = 'Requesting pairing code…';
        const sessionId = Date.now().toString(36);
        startPolling(sessionId);

        const codeRes = await fetch(`/connect?phoneNumber=${encodeURIComponent(number)}&filename=${encodeURIComponent(uploadData.filename)}&sessionId=${sessionId}`);
        const codeData = await codeRes.json();

        if (codeData.code) {
            setStep(2);
            pairingCodeEl.textContent = codeData.code.toUpperCase();
            pairingBox.classList.remove('hidden');
            statusMsgText.textContent = 'Pairing code ready — enter it on your phone to link.';
        } else {
            stopPolling();
            resultBox.innerHTML = `<span class="err">${codeData.error || 'Failed to generate pairing code.'}</span>`;
            resetCta();
        }
    } catch (err) {
        console.error(err);
        stopPolling();
        resultBox.innerHTML = `<span class="err">Something went wrong. Try again.</span>`;
        resetCta();
    }
});
