document.getElementById('contractFile').addEventListener('change', function () {
    const file = this.files[0];
    document.getElementById('fileName').textContent = file ? file.name : '';
});

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsText(file);
    });
}

async function translateContract() {
    const fileInput = document.getElementById('contractFile');
    const statusBox = document.getElementById('translateStatus');
    const outputBox = document.getElementById('translationOutput');
    const button = document.getElementById('translateBtn');

    const file = fileInput.files[0];
    if (!file) {
        statusBox.textContent = 'Choose a .sol file first.';
        return;
    }

    button.disabled = true;
    statusBox.textContent = 'Reading file...';
    outputBox.textContent = 'Loading...';

    try {
        const contractCode = await readFileAsText(file);

        statusBox.textContent = 'Asking the AI to explain this contract (this can take a moment)...';

        const body = new URLSearchParams({ contractCode });
        const response = await fetch('/api/translate_contract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        });
        const html = await response.text();

        outputBox.innerHTML = html;
        statusBox.textContent = 'Done.';
    } catch (err) {
        statusBox.textContent = 'Error translating contract.';
        outputBox.textContent = '';
        console.error(err);
    } finally {
        button.disabled = false;
    }
}
