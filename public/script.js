const $ = (id) => document.getElementById(id);
const dropZone = $('dropZone'), imageInput = $('imageInput'), preview = $('preview'), dropHint = $('dropHint');
const resultBox = $('result'), pairingBox = $('pairingBox'), pairingCodeEl = $('pairingCode');
const monitor = $('monitor'), statusMsg = $('statusMsg'), cta = $('submitBtn'), ctaText = $('ctaText');

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
    let last = '';
    pollTimer = setInterval(async () => {
        try {
            const r = await fetch(`/connect/status?sessionId=${encodeURIComponent(sessionId)}`);
            const d = await r.json();
            if (d.step && d.status !== last) { last = d.status; setStep(d.step); statusMsg.textContent = d.message || ''; }
        } catch (_) {}
    }, 1500);
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
function resetCta() { cta.disabled = false; ctaText.textContent = '🚀 Set My Full Screen DP'; }

$('uploadForm').addEventListener('submit', async e => {
    e.preventDefault();
    stopPolling();
    const number = $('numberInput').value.trim();
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
            statusMsg.textContent = 'Check your phone — enter the code to finish linking…';
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

window.onload = () => {
    if (!sessionStorage.getItem('infoModalShown')) setTimeout(() => $('infoModal').classList.remove('hidden'), 2500);
};
function closeModal() { $('infoModal').classList.add('hidden'); sessionStorage.setItem('infoModalShown', 'true'); }
function openModal() { $('infoModal').classList.remove('hidden'); }
window.addEventListener('click', e => { if (e.target === $('infoModal')) closeModal(); });
