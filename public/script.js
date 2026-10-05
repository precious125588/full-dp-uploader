const $ = (id) => document.getElementById(id);
const dropZone = $('dropZone');
const imageInput = $('imageInput');
const preview = $('preview');
const dropHint = $('dropHint');
const resultBox = $('result');
const pairingBox = $('pairingBox');
const pairingCodeEl = $('pairingCode');
const monitor = $('monitor');
const statusMsg = $('statusMsg');
const cta = $('submitBtn');
const ctaText = $('ctaText');

// ---- drag & drop / preview ----
dropZone.addEventListener('click', () => imageInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag');
    if (e.dataTransfer.files.length) {
        imageInput.files = e.dataTransfer.files;
        showPreview();
    }
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

// ---- monitor ----
function setStep(step) {
    document.querySelectorAll('#steps li').forEach(li => {
        const n = Number(li.dataset.step);
        li.classList.toggle('done', n < step);
        li.classList.toggle('active', n === step);
    });
}

let pollTimer = null;
function startPolling(sessionId) {
    monitor.classList.remove('hidden');
    setStep(1);
    statusMsg.textContent = 'Initializing…';
    let lastStatus = '';
    pollTimer = setInterval(async () => {
        try {
            const r = await fetch(`/connect/status?sessionId=${encodeURIComponent(sessionId)}`);
            const d = await r.json();
            if (d.step && d.status !== lastStatus) {
                lastStatus = d.status;
                setStep(d.step);
                statusMsg.textContent = d.message || '';
            }
        } catch (_) {}
    }, 1500);
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

// ---- submit flow ----
$('uploadForm').addEventListener('submit', async e => {
    e.preventDefault();
    stopPolling();
    const number = $('numberInput').value.trim().replace(/[^0-9]/g, '');
    const image = imageInput.files[0];

    resultBox.innerHTML = '';
    pairingBox.classList.add('hidden');
    monitor.classList.add('hidden');

    if (!number || !image) {
        resultBox.innerHTML = `<span class="err">Please provide both number and image.</span>`;
        return;
    }

    cta.disabled = true;
    ctaText.textContent = 'Uploading image…';

    const formData = new FormData();
    formData.append('image', image);

    try {
        // Step 1: upload image
        const uploadRes = await fetch('/upload', { method: 'POST', body: formData });
        const uploadData = await uploadRes.json();

        if (!uploadData.filename) {
            resultBox.innerHTML = `<span class="err">Image upload failed. Try again.</span>`;
            cta.disabled = false;
            ctaText.textContent = '🚀 Set My Full Screen DP';
            return;
        }

        // Step 2: request pairing code (start polling the live monitor)
        ctaText.textContent = 'Requesting pairing code…';
        startPolling(Date.now().toString(36) + Math.random().toString(36).slice(2, 6));

        const sessionId = Date.now().toString(36);
        const codeRes = await fetch(`/connect?phoneNumber=${number}&filename=${encodeURIComponent(uploadData.filename)}&sessionId=${sessionId}`);
        const codeData = await codeRes.json();

        if (codeData.code) {
            setStep(2);
            pairingCodeEl.textContent = codeData.code.toUpperCase();
            pairingBox.classList.remove('hidden');
            statusMsg.textContent = 'Waiting for you to enter the code on your phone…';
            // re-poll with the real sessionId
            stopPolling();
            startPolling(sessionId);
        } else {
            stopPolling();
            resultBox.innerHTML = `<span class="err">${codeData.error || 'Failed to generate pairing code.'}</span>`;
            cta.disabled = false;
            ctaText.textContent = '🚀 Set My Full Screen DP';
        }
    } catch (err) {
        console.error(err);
        stopPolling();
        resultBox.innerHTML = `<span class="err">Something went wrong. Try again.</span>`;
        cta.disabled = false;
        ctaText.textContent = '🚀 Set My Full Screen DP';
    }
});

// ---- modal ----
window.onload = () => {
    if (!sessionStorage.getItem('infoModalShown')) {
        setTimeout(() => $('infoModal').classList.remove('hidden'), 2500);
    }
};
function closeModal() {
    $('infoModal').classList.add('hidden');
    sessionStorage.setItem('infoModalShown', 'true');
}
function openModal() { $('infoModal').classList.remove('hidden'); }
window.addEventListener('click', e => {
    if (e.target === $('infoModal')) closeModal();
});
