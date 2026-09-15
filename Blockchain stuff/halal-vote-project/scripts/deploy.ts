import { network } from "hardhat";

async function main() {
  const { ethers } = await network.getOrCreate("privatePoA");

  const voters = [
    "0x2001098901B4Bf716f39F30367115575a2d6B982",
    "0xd8186e1A07b7871A5B721cC45575cdE70B794619",
    "0xc6172D4Bf3AB3e8d5c5bf6a7f1805F59cfbf36BE",
    "0x3C759Ce6e2150212589DA464f4D7FF1eB490E04C",
  ];

  const contract = await ethers.deployContract("HalalCryptoVote", [voters]);
  await contract.waitForDeployment();

  console.log("Deployed at:", await contract.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});