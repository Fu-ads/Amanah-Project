let signer = null;

function isScholar() {
    return account && account.role === 'scholar';
}

function applyRoleGate() {
    const notice = document.getElementById('scholarNotice');
    const voteControls = document.getElementById('scholarVoteControls');
    const proposalControls = document.getElementById('scholarProposalControls');

    if (isScholar()) {
        notice.style.display = 'none';
        voteControls.style.display = 'block';
        proposalControls.style.display = 'block';
        loadProposals();
    } else {
        notice.style.display = 'block';
        voteControls.style.display = 'none';
        proposalControls.style.display = 'none';
    }
}

async function connectWallet() {
    const statusBox = document.getElementById('walletStatus');
    if (!window.ethereum) {
        statusBox.textContent = 'MetaMask not detected. Please install it.';
        return;
    }
    if (!publicRpcUrl) {
        statusBox.textContent = 'Server misconfiguration: publicRpcUrl is not set in config.env.';
        return;
    }
    try {
        try {
            await window.ethereum.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: '0x' + expectedChainId.toString(16) }]
            });
        } catch (switchErr) {
            if (switchErr.code === 4902) {
                await window.ethereum.request({
                    method: 'wallet_addEthereumChain',
                    params: [{
                        chainId: '0x' + expectedChainId.toString(16),
                        chainName: 'Halal Vote Network',
                        rpcUrls: [publicRpcUrl],
                        nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }
                    }]
                });
            } else {
                throw switchErr;
            }
        }

        const browserProvider = new ethers.BrowserProvider(window.ethereum);
        await browserProvider.send('eth_requestAccounts', []);
        signer = await browserProvider.getSigner();
        const address = await signer.getAddress();

        if (account.walletAddress && address.toLowerCase() !== account.walletAddress.toLowerCase()) {
            statusBox.textContent = `Warning: connected wallet (${address}) does not match your registered scholar wallet (${account.walletAddress}). Votes will be sent from the connected wallet, which may not be an authorized voter on-chain.`;
        } else {
            statusBox.textContent = `Connected: ${address}`;
        }
    } catch (err) {
        statusBox.textContent = `Connection failed: ${err.message || err.code || 'unknown error'}`;
        console.error(err);
    }
}

async function loadProposals() {
    const symbol = document.getElementById('coinSymbol').value;
    const select = document.getElementById('proposalId');
    select.innerHTML = '<option value="">Loading...</option>';
    try {
        const res = await fetch(`/api/proposals/${encodeURIComponent(symbol)}`);
        const data = await res.json();
        if (!data.success || data.proposals.length === 0) {
            select.innerHTML = '<option value="">No proposals yet for this coin</option>';
            return;
        }
        select.innerHTML = data.proposals.map(p =>
            `<option value="${p.id}">#${p.id} - ${p.description} ${p.active ? '(open)' : '(closed)'}</option>`
        ).join('');
        fetchTally(select.value);
    } catch (err) {
        select.innerHTML = '<option value="">Error loading proposals</option>';
        console.error(err);
    }
}

async function castVote(choice) {
    const proposalId = document.getElementById('proposalId').value;
    const resultBox = document.getElementById('voteResult');

    if (!isScholar()) {
        resultBox.textContent = 'Only scholar accounts can vote.';
        return;
    }
    if (!signer) {
        resultBox.textContent = 'Connect your wallet first.';
        return;
    }
    if (!proposalId) {
        resultBox.textContent = 'No proposal selected.';
        return;
    }

    resultBox.textContent = 'Submitting vote (confirm in MetaMask)...';
    try {
        const contract = new ethers.Contract(contractAddress, contractAbi, signer);
        const tx = await contract.castVote(proposalId, choice, { gasPrice: 0 });
        resultBox.textContent = 'Waiting for confirmation...';
        await tx.wait();
        resultBox.textContent = `Vote recorded. Tx: ${tx.hash}`;
        fetchTally(proposalId);
    } catch (err) {
        resultBox.textContent = `Error: ${err.reason || err.message}`;
        console.error(err);
    }
}

async function createProposal() {
    const symbol = document.getElementById('coinSymbol').value;
    const description = document.getElementById('proposalDescription').value;
    const durationSeconds = document.getElementById('proposalDuration').value;
    const resultBox = document.getElementById('proposalResult');

    if (!isScholar()) {
        resultBox.textContent = 'Only scholar accounts can create proposals.';
        return;
    }
    if (!signer) {
        resultBox.textContent = 'Connect your wallet first.';
        return;
    }

    resultBox.textContent = 'Creating proposal (confirm in MetaMask)...';
    try {
        const contract = new ethers.Contract(contractAddress, contractAbi, signer);
        const tx = await contract.createProposal(symbol, description, parseInt(durationSeconds), { gasPrice: 0 });
        resultBox.textContent = 'Waiting for confirmation...';
        await tx.wait();
        resultBox.textContent = `Proposal created. Tx: ${tx.hash}`;
        loadProposals();
    } catch (err) {
        resultBox.textContent = `Error: ${err.reason || err.message}`;
        console.error(err);
    }
}

let tallyPollInterval = null;

async function fetchTally(proposalId) {
    const tallyBox = document.getElementById('tallyResult');

    if (tallyPollInterval) {
        clearInterval(tallyPollInterval);
        tallyPollInterval = null;
    }

    if (!proposalId) {
        tallyBox.textContent = 'No proposal selected.';
        return;
    }
    tallyBox.textContent = 'Loading...';
    try {
        const res = await fetch(`/api/tally/${proposalId}`);
        const data = await res.json();
        if (data.status === 'not yet tallied') {
            tallyBox.textContent = 'Voting still in progress. This will update automatically once the deadline passes.';
            // Poll every 10s so the result appears on its own the moment
            // voting ends - no manual action needed.
            tallyPollInterval = setInterval(() => fetchTally(proposalId), 10000);
        } else if (data.success) {
            tallyBox.textContent = `Halal: ${data.halal} | Not Halal: ${data.notHalal} | Abstain: ${data.abstain}`;
        } else {
            tallyBox.textContent = `Error: ${data.reason}`;
        }
    } catch (err) {
        tallyBox.textContent = 'Error fetching tally.';
        console.error(err);
    }
}

document.addEventListener('DOMContentLoaded', applyRoleGate);
