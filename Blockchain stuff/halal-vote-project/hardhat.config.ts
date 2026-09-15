import { defineConfig, configVariable } from "hardhat/config";
import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatKeystore from "@nomicfoundation/hardhat-keystore";

export default defineConfig({
  plugins: [hardhatEthers, hardhatKeystore],
  solidity: {
    version: "0.8.28",
    settings: {
      evmVersion: "istanbul",
    },
  },
  networks: {
    privatePoA: {
      type: "http",
      url: "http://127.0.0.1:8545",
      accounts: [configVariable("VOTER1_PRIVATE_KEY")],
    },
  },
});