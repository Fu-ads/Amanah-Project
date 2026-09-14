async function loadProposalsForVotes() {
    const select = document.getElementById('votesProposalSelect');
    select.innerHTML = '<option value="">Loading...</option>';
    try {
        const res = await fetch(`/api/proposals/${encodeURIComponent(coinSymbol)}`);
        const data = await res.json();
        if (!data.success || data.proposals.length === 0) {
            select.innerHTML = '<option value="">No proposals yet</option>';
            return;
        }
        select.innerHTML = data.proposals.map(p =>
            `<option value="${p.id}">#${p.id} - ${p.description} ${p.active ? '(open)' : '(closed)'}</option>`
        ).join('');
        loadVotes(select.value);
    } catch (err) {
        select.innerHTML = '<option value="">Error loading proposals</option>';
        console.error(err);
    }
}

async function loadVotes(proposalId) {
    const descBox = document.getElementById('votesDescription');
    const list = document.getElementById('votesList');

    if (!proposalId) {
        descBox.textContent = '';
        list.innerHTML = '';
        return;
    }

    descBox.textContent = 'Loading...';
    list.innerHTML = '';

    try {
        const res = await fetch(`/api/votes/${proposalId}`);
        const data = await res.json();
        if (!data.success) {
            descBox.textContent = `Error: ${data.reason}`;
            return;
        }
        descBox.textContent = data.description;
        if (data.votes.length === 0) {
            list.innerHTML = '<li>No votes cast yet.</li>';
            return;
        }
        list.innerHTML = data.votes.map(v =>
            `<li><span class="voter">${v.voter}</span><span class="choice">${v.choice}</span></li>`
        ).join('');
    } catch (err) {
        descBox.textContent = 'Error loading votes.';
        console.error(err);
    }
}

document.addEventListener('DOMContentLoaded', loadProposalsForVotes);
