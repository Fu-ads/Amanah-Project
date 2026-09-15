// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract HalalCryptoVote {
    enum Choice { NONE, HALAL, NOT_HALAL, ABSTAIN }

    struct Proposal {
        string cryptoSymbol;
        string description;
        uint256 deadline;
        bool closed;
        mapping(address => Choice) votes;
        address[] voters;
    }

    address[4] public authorizedVoters;
    mapping(uint256 => Proposal) private proposals;
    mapping(string => uint256[]) private symbolProposals; // NEW: symbol -> proposal IDs
    uint256 public proposalCount;

    event ProposalCreated(uint256 id, string symbol, uint256 deadline);
    event VoteCast(uint256 id, address voter, Choice choice);
    event ProposalClosed(uint256 id, uint256 halal, uint256 notHalal, uint256 abstain);

    modifier onlyAuthorized() {
        bool ok;
        for (uint i = 0; i < 4; i++) {
            if (authorizedVoters[i] == msg.sender) ok = true;
        }
        require(ok, "Not an authorized voter node");
        _;
    }

    constructor(address[4] memory voters) {
        authorizedVoters = voters;
    }

    function createProposal(string calldata symbol, string calldata desc, uint256 durationSeconds)
        external onlyAuthorized returns (uint256)
    {
        uint256 id = proposalCount++;
        Proposal storage p = proposals[id];
        p.cryptoSymbol = symbol;
        p.description = desc;
        p.deadline = block.timestamp + durationSeconds;
        symbolProposals[symbol].push(id); // NEW: index this proposal under its symbol
        emit ProposalCreated(id, symbol, p.deadline);
        return id;
    }

    function castVote(uint256 id, Choice choice) external onlyAuthorized {
        Proposal storage p = proposals[id];
        require(block.timestamp <= p.deadline, "Voting closed");
        require(p.votes[msg.sender] == Choice.NONE, "Already voted");
        require(choice != Choice.NONE, "Invalid choice");

        p.votes[msg.sender] = choice;
        p.voters.push(msg.sender);
        emit VoteCast(id, msg.sender, choice);
    }

    function tally(uint256 id) external returns (uint256 halal, uint256 notHalal, uint256 abstain) {
        Proposal storage p = proposals[id];
        require(block.timestamp > p.deadline, "Not yet closed");
        require(!p.closed, "Already tallied");

        for (uint i = 0; i < p.voters.length; i++) {
            Choice c = p.votes[p.voters[i]];
            if (c == Choice.HALAL) halal++;
            else if (c == Choice.NOT_HALAL) notHalal++;
            else if (c == Choice.ABSTAIN) abstain++;
        }
        p.closed = true;
        emit ProposalClosed(id, halal, notHalal, abstain);
    }

    // NEW: look up every proposal ID ever created for a given coin symbol
    function getProposalsBySymbol(string calldata symbol) external view returns (uint256[] memory) {
        return symbolProposals[symbol];
    }

    // NEW: safe getter for a proposal's basic info (mappings inside the struct
    // can't be returned directly, so this exposes only the plain fields)
    function getProposal(uint256 id) external view returns (
        string memory symbol,
        string memory description,
        uint256 deadline,
        bool closed
    ) {
        Proposal storage p = proposals[id];
        return (p.cryptoSymbol, p.description, p.deadline, p.closed);
    }
}
