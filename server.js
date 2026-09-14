// web server modules
import https from 'http2';
import http from 'http';
import ejs from 'ejs';
import * as fs from 'fs/promises';
import { customAlphabet } from 'nanoid';
import { MongoClient } from 'mongodb';
import nodemailer from 'nodemailer';
import bcrypt from 'bcrypt';
import constants from 'constants';
import { TTLCache } from '@isaacs/ttlcache'
import ollama from 'ollama';
import { ethers } from 'ethers';

// constants
process.loadEnvFile('config.env')
const httpsPORT = parseInt(process.env.httpsPORT);
const httpPORT = parseInt(process.env.httpPORT);
const dbURL = process.env.dbURL;
const database = process.env.database;
const collection = process.env.collection
const cryptoCurrencies = [];
const sessionsCache = new TTLCache({ ttl: 3600000 })

// Blockchain (halal-vote) constants
// Add these keys to config.env: rpcURL, publicRpcUrl, contractAddress, contractArtifactPath
// (No more VOTER*_PRIVATE_KEY needed - MetaMask signs client-side now.)
const provider = new ethers.JsonRpcProvider(process.env.rpcURL || 'http://127.0.0.1:8545');
const contractAddress = process.env.contractAddress;
// The signer node network's PUBLIC RPC URL, e.g. http://your-public-ip:8545 -
// this is what gets sent to the browser for MetaMask to use.
const publicRpcUrl = process.env.publicRpcUrl;
// Path to the compiled artifact from your halal-vote-project's Hardhat build,
// e.g. '../halal-vote-project/artifacts/contracts/HalalCryptoVote.sol/HalalCryptoVote.json'
const contractArtifact = JSON.parse(await fs.readFile(process.env.contractArtifactPath, 'utf8'));
const contractAbi = contractArtifact.abi;

// Startup sanity check: warn immediately if nothing is actually deployed at
// contractAddress on the chain rpcURL points to, instead of only finding out
// later via a "could not decode result data" error on the first request.
// This happens most often after a node restart wipes chain data (e.g. via
// setup-nodes-auto.ps1) without redeploying and updating config.env after.
; (async () => {
    try {
        const code = await provider.getCode(contractAddress)
        if (code === '0x') {
            console.warn('\n[WARNING] No contract code found at contractAddress:')
            console.warn(`  ${contractAddress}`)
            console.warn(`  on chain ${process.env.rpcURL || 'http://127.0.0.1:8545'}`)
            console.warn('  This usually means the chain was reset (e.g. by re-running a node')
            console.warn('  setup script) since the contract was last deployed. Redeploy with:')
            console.warn('    cd halal-vote-project && npx hardhat run scripts/deploy.ts --network privatePoA')
            console.warn('  then update contractAddress in config.env and restart this server.\n')
        } else {
            console.log(`Contract code confirmed at ${contractAddress}`)
        }
    } catch (err) {
        console.warn('\n[WARNING] Could not reach the blockchain RPC to verify the contract:')
        console.warn(`  ${err.message}`)
        console.warn('  Check that your Geth nodes are running and rpcURL in config.env is correct.\n')
    }
})();
const cacheSummaryEvery = 1000 * 60 * 60 * 24 // <--- Number of hours
const SSLdirectory = process.env.SSLdirectory;
const mailConnection = {
    host: process.env.mailHost,
    port: process.env.mailPort,
}
if (process.env.mailUser !== '')
    mailConnection['auth'] = { user: process.env.mailUser, pass: process.env.mailPass }
else
    mailConnection['tls'] = { rejectUnauthorized: false }
const mailServer = nodemailer.createTransport(mailConnection)
const loginAttempts = new Map();
const mongoClient = new MongoClient(dbURL);
const generateID = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', 11);

// Setup
const cert = await fs.readFile(`${SSLdirectory}/${process.env.SSLfullCertificate}`)
const key = await fs.readFile(`${SSLdirectory}/${process.env.SSLkey}`)
const SSLpassphrase = process.env.SSLpassphrase;
const ca = await fs.readFile(`${SSLdirectory}/${process.env.SSLchain}`)
function sslOptions() {
    return {
        cert: cert,
        key: key,
        passphrase: SSLpassphrase,
        ca: ca,
        // Enable all security features
        minVersion: 'TLSv1.2',
        // Recommended security settings
        ciphers: [
            'ECDHE-RSA-AES128-SHA',
            'ECDHE-RSA-AES256-SHA',
            'AES128-SHA',
            'AES256-SHA'
        ].join(':'),
        honorCipherOrder: true,
        secureOptions: constants.SSL_OP_NO_SSLv3 |
            constants.SSL_OP_NO_TLSv1 |
            constants.SSL_OP_NO_TLSv1_1,
        // Enable fallback to http 1.1
        allowHTTP1: true
    }
};

async function initializeDatabase() {
    await mongoClient.connect()
    await mongoClient.db(database).collection('accounts').createIndex({ id: 1 }, { unique: true })
    await mongoClient.db(database).collection('accounts').createIndex({ email: 1 }, { unique: true })
    await mongoClient.db(database).collection('accounts').createIndex({ username: 1 }, { unique: true })
    await mongoClient.db(database).collection('accounts').createIndex({ role: 1 })
    await mongoClient.db(database).collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 10 })
    await mongoClient.db(database).collection('sessions').createIndex({ id: 1 }, { unique: true })

    // Create the coin data base
    await mongoClient.db(database).collection(collection).createIndex({ title: 1 }, { unique: true })
    await mongoClient.db(database).collection(collection).createIndex({ status: 1 })
    await mongoClient.db(database).collection(collection).createIndex({ usecases: 1 })
    // Load the coins into the database
    // let list = (await fs.readFile('list.csv', 'utf-8')).replaceAll(" ", "").split(",")
    // // list.forEach(async (e) => await makeCoin(e))
    // list.forEach(async (e) => console.log(`${await makeCoin(e)}`))
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let rawData = ''
        req.on('data', (chunk) => {
            rawData += chunk
        })
        req.on('end', () => {
            req.body = rawData
            resolve(req)
        })
        req.on('error', reject)
    })
}
async function getForm(req) {
    await parseBody(req)
    let params = new URLSearchParams(req.body)
    let jsonObject = {}
    for (const [key, value] of params) {
        jsonObject[key] = value
    }
    req.body = jsonObject
}
async function getSession(sessionID) {
    let session = sessionsCache.get(sessionID)
    if (session && session.expiresAt > new Date()) return session;
    try {
        let sessiondb = mongoClient.db(database).collection('sessions')
        session = await sessiondb.findOne({ id: sessionID, expiresAt: { $gt: new Date() } })
        if (!session) return undefined;
        let accountdb = mongoClient.db(database).collection('accounts')
        let account = await accountdb.findOne({ id: session.accountID })
        session.role = account.role
        delete session._id
        delete session.id
        sessionsCache.set(sessionID, session);
        return session;
    } catch (err) {
        console.log(err)
        return undefined;
    }
}
function invalid(req, res) {
    function cleanup(username, record, ip) {
        let attempts = record.get(ip)
        if (!attempts) return;
        attempts['attempts'] -= 1
        if (attempts['attempts'] == 0) {
            record.delete(ip)
            if (record.size == 0)
                loginAttempts.delete(username)
        } else {
            setTimeout(() => { cleanup(username, record, ip) }, 600000)
        }
    }
    if (!loginAttempts.has(req.body['username'])) {
        let attempt = (new Map()).set(req.socket.remoteAddress, { attempts: 1 })
        loginAttempts.set(req.body['username'], attempt)
        setTimeout(() => { cleanup(req.body['username'], attempt, req.socket.remoteAddress) }, 600000)
        res.writeHead(401)
        res.end('{"success": false, "reason": "Invalid login request!"}')
        return;
    } else {
        let attempt = loginAttempts.get(req.body['username'])
        if (!attempt.has(req.socket.remoteAddress)) {
            attempt.set(req.socket.remoteAddress, { attempts: 1 })
            setTimeout(() => { cleanup(req.body['username'], attempt, req.socket.remoteAddress) }, 600000)
            res.writeHead(401)
            res.end('{"success": false, "reason": "Invalid login request!"}')
            return;
        }
        let attempts = attempt.get(req.socket.remoteAddress)
        if (attempts['attempts'] == 5) {
            res.writeHead(429)
            res.end('{"locked":true, "reason": "Account Locked!"}')
            return;
        }
        if (attempts['attempts'] < 5) {
            attempts['attempts'] += 1
            if (attempts['attempts'] == 5) {
                res.writeHead(429)
                res.end('{"locked":true}')
                return;
            }
            res.writeHead(401)
            res.end('{"success": false, "reason": "Invalid login request!"}')
            return;
        }
    }
}
// AI Generated function:
async function aiSummarize(cryptoName) {
    if (!cryptoName) {
        return "Error: no cryptocurrency selected";
    }
    try {
        // No "new Ollama()" needed here anymore!
        const response = await ollama.chat({
            model: 'gemma4',
            messages: [
                {
                    role: 'system',
                    content: 'You are a professional financial analyst assistant.'
                },
                {
                    role: 'user',
                    content: `Provide a concise, professional summary of the cryptocurrency "${cryptoName}". 
                    Include its primary use case, consensus mechanism (e.g., Proof of Work/Stake), 
                    and major pros/cons. Format the output cleanly in HTML as this response will be injected automatically into a webpage. 
                    No styling elements outside the div element being injected into.
                    The structure needs to be: 
                    Overview, Primary use case, major pros, major cons in that sequence and not in a table.`
                }
            ],
            stream: false
        });
        return response.message.content.replace('\`\`\`html', '').replace('\`\`\`', '');
    } catch (error) {
        console.error('Error 500: Internal Server Error', error);
        return "Error 500: Internal Server Error";
    }
}
// AI Generated function:
async function aiTranslateContract(contractCode) {
    if (!contractCode || !contractCode.trim()) {
        return "Error: no contract provided";
    }
    try {
        const response = await ollama.chat({
            model: 'gemma4',
            messages: [
                {
                    role: 'system',
                    content: 'You are a professional smart contract auditor and educator who explains Solidity code in plain English for a non-technical audience.'
                },
                {
                    role: 'user',
                    content: `Explain what the following Solidity smart contract does in plain, non-technical English.
                    Format the output cleanly in HTML as this response will be injected automatically into a webpage.
                    No styling elements outside the div element being injected into.
                    The structure needs to be:
                    Overview, What it does step-by-step, Who is allowed to do what, Notable risks or things to watch out for.

                    Contract code:
                    ${contractCode}`
                }
            ],
            stream: false
        });
        return response.message.content.replace('\`\`\`html', '').replace('\`\`\`', '');
    } catch (error) {
        console.error('Error 500: Internal Server Error', error);
        return "Error 500: Internal Server Error";
    }
}
async function makeCoin(coin) {
    try {
        await mongoClient.db(database).collection(collection).insertOne({
            title: coin,
            status: "TBD",
            usecases: "",
            summary: "",
            summaryDate: new Date()
        })
        return `Added ${coin} to MongoDB`
    }
    catch (err) {
        return `Error adding ${coin} to MongoDB\n${err}`
    }
}

// Create a server object
const server = https.createSecureServer(sslOptions(), async (req, res) => {
    let fullUrl = null;
    if (req.httpVersion == 1.1) {
        if (req.headers.host == '' || req.headers.host == '/')
            req.headers.host = 'undefined'
        fullUrl = new URL(req.url, `https://${req.headers.host}`);
    } else {
        if (req.headers[':authority'] == '' || req.headers[':authority'] == '/')
            req.headers[':authority'] = 'undefined'
        fullUrl = new URL(req.url, `https://${req.headers[':authority']}`)
    }
    const queryParams = fullUrl.searchParams;
    const urlPath = fullUrl.pathname.replaceAll("%20", " ")
    if (!urlPath.endsWith('.css') && !urlPath.endsWith('.png') && !urlPath.endsWith('.mp4') && !urlPath.endsWith('.m3u8') && !urlPath.endsWith('.ico') && !urlPath.endsWith('.js')) {
        console.log(`[${new Date().toLocaleString()}] [MAIN]: [${req.socket.remoteAddress}] ${req.method} ${fullUrl}`);
    }
    // format cookies
    let cookies = {}
    req.headers.cookie?.split(';').forEach(cookie => {
        let [name, value] = cookie.trim().split('=');
        cookies[name] = value;
    });

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, X-Content-Range, Location');
    res.setHeader('Content-Security-Policy', "frame-ancestors *");
    res.setHeader('X-Frame-Options', 'ALLOWALL');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Account Handling
    if (urlPath == "/renewSession") {
        try {
            let sessiondb = mongoClient.db(database).collection('sessions')
            let session = await getSession(cookies['sessionID'])
            if (!session) {
                res.writeHead(440, {
                    'Content-Type': 'application/json'
                })
                res.end('{"success":false}')
                return;
            }
            let accountdb = mongoClient.db(database).collection('accounts')
            let account = await accountdb.findOne({ id: cookies['sessionID'] })
            let expirationDate = new Date()
            expirationDate.setHours(expirationDate.getHours() + 2)
            let sessionID = crypto.randomUUID()
            while ((await sessiondb.findOne({ id: sessionID })))
                sessionID = crypto.randomUUID()
            await sessiondb.updateOne({ id: cookies['sessionID'] }, { $set: { id: sessionID, expiresAt: expirationDate } })
            sessionsCache.delete(cookies['sessionID'])
            sessionsCache.set(sessionID, { accountID: account.id, expiresAt: expirationDate, role: account.role })
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Set-Cookie': `sessionID=${sessionID}; Path=/; HttpOnly; Max-Age=7200; SameSite=Strict; Secure`
            })
            res.end(`{"success":true,"expiresAt":"${expirationDate}"}`)
        } catch (err) {
            console.log(err)
            res.writeHead(500)
            res.end()
        }
        return;
    }
    if (urlPath == "/login" && req.method == 'POST') {
        try {
            await getForm(req)
            let sessiondb = mongoClient.db(database).collection('sessions')
            let accountdb = mongoClient.db(database).collection('accounts')
            let session = await sessiondb.findOne({ id: cookies['sessionID'], expiresAt: { $gt: new Date() } })
            if (session) {
                let account = await accountdb.findOne({ id: session.accountID })
                if ((!req.body['username'] || req.body['username'] == account.username)) {
                    res.writeHead(200, {
                        'Content-Type': 'application/json'
                    })
                    res.end(`{"success":false, "expiresAt":"${session['expiresAt']}"}`)
                    return;
                }
            }
            if (typeof req.body['username'] !== 'string' || typeof req.body['password'] !== 'string' || req.body['username'].length > 256 || req.body['password'].length > 256 || req.body['username'].length < 3 || req.body['password'].length < 6) {
                res.writeHead(401, {
                    'Content-Type': 'application/json'
                })
                res.end('{"success": false, "reason": "Invalid login request!"}')
                return;
            }
            let valid = loginAttempts.get(req.body['username'])?.get(req.socket.remoteAddress) ?? { attempts: 0 };
            if (valid['attempts'] == 5) {
                res.writeHead(429)
                res.end('{"locked":true, "reason":"Account Locked!"}')
                return;
            }
            let account = await accountdb.findOne({ username: req.body['username'] })
            if (!account) {
                await bcrypt.compare('invalid', '$2b$12$qBOoJTrf2A5NuPevDlFAQ.C67h1ZZ9d9TVOqwiDOZKAHgkj7dS2G2')
                invalid(req, res)
                return;
            }
            let password = req.body['password']
            if (!(await bcrypt.compare(password, account.password))) {
                invalid(req, res)
                return;
            }
            // Successfully logged in
            let attempts = loginAttempts.get(req.body['username'])
            if (attempts) {
                attempts.delete(req.socket.remoteAddress)
                if (attempts.size == 0)
                    loginAttempts.delete(req.body['username'])
            }
            if (cookies['sessionID']) {
                await sessiondb.deleteOne({ id: cookies['sessionID'] })
            }
            let sessionID = crypto.randomUUID()
            while ((await sessiondb.findOne({ id: sessionID })))
                sessionID = crypto.randomUUID()
            let expirationDate = new Date()
            expirationDate.setHours(expirationDate.getHours() + 2)
            await sessiondb.insertOne({ id: sessionID, accountID: account.id, expiresAt: expirationDate })
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Set-Cookie': `sessionID=${sessionID}; Path=/; HttpOnly; Max-Age=7200; SameSite=Strict; Secure`
            })
            res.end(`{"success":true,"expiresAt":"${expirationDate}","account":{"name":"${account.username}", "role":"${account.role || ''}","walletAddress":"${account.walletAddress || ''}"}}`)
        } catch (err) {
            console.log(err)
            res.writeHead(500)
            res.end()
        }
        return;
    }
    if (urlPath == '/signup' && req.method == 'POST') {
        await getForm(req)
        if (typeof req.body['username'] !== 'string' || typeof req.body['password'] !== 'string' || req.body['password'].length > 256 || req.body['username'].length < 3 || req.body['password'].length < 6 || !req.body['accountID']) {
            res.writeHead(401, {
                'Content-Type': 'application/json'
            })
            res.end('{"success": false, "reason": "invalid request"}')
            return;
        }
        try {
            let accountdb = mongoClient.db(database).collection('accounts')
            let account = await accountdb.findOne({ id: req.body['accountID'] })
            if (req.body['verificationLink'] != account.verificationLink) {
                res.writeHead(401, {
                    'Content-Type': 'application/json'
                })
                res.end('{"success": false, "reason": "invalid request"}')
                return;
            }
            if (await accountdb.findOne({ username: req.body['username'] })) {
                res.writeHead(400, {
                    'Content-Type': 'application/json'
                })
                res.end('{"success": false, "reason": "the name is already in use."}')
                return;
            }
            req.body['password'] = await bcrypt.hash(req.body['password'], 12);
            await accountdb.updateOne({ id: req.body['accountID'] }, { $set: { username: req.body['username'], password: req.body['password'], verified: true }, $unset: { validity: 1, verificationLink: 1 } })
        } catch (err) {
            console.log(err)
            res.writeHead(500)
            res.end()
        }
        return;
    }
    if (urlPath == "/resetPassword" && req.method == 'POST') {
        try {
            await getForm(req) // recieve email/username
            let accountdb = mongoClient.db(database).collection('accounts')
            let account;
            if (/^[^\s@]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(req.body['username']))
                account = await accountdb.findOne({ email: req.body['username'] })
            else
                account = await accountdb.findOne({ id: req.body['username'] })
            if (!account || OTPMap.get(account.id)?.['resetPassword']['requests'] == MAX_OTP_REQUESTS) {
                res.writeHead(200, {
                    'Content-Type': 'application/json'
                })
                res.end('{"success": true, "reason": "check your emails for a OTP"}')
                return;
            }
            let OTP = generateOTP();
            await mailServer.sendMail({
                from: 'No-Reply@themysticrealm.net',
                to: account.email,
                subject: 'One-Time Password',
                text: OTP
            })
            if (!OTPMap.has(account.id))
                OTPMap.set(account.id, { 'resetPassword': { code: null, attempts: 0, requests: 0, expiration: null } })
            let expiration = new Date();
            expiration.setMinutes(expiration.getMinutes() + OTP_EXPIRY)
            let OTPRequest = OTPMap.get(account.id)['resetPassword']
            OTPRequest['code'] = OTP
            OTPRequest['attempts'] = 0
            OTPRequest['requests'] += 1
            OTPRequest['expiration'] = expiration
            if (OTPRequest['requests'] == 1) {
                setTimeout((account) => {
                    if (OTPMap.get(account)?.['resetPassword']) {
                        delete OTPMap.get(account)['resetPassword']
                        if (Object.keys(OTPMap.get(account)).length == 0)
                            OTPMap.delete(account)
                    }
                }, RATE_LIMIT_RESET, account.id)
            }
            res.writeHead(200, {
                'Content-Type': 'application/json'
            })
            res.end('{"success": true, "reason": "check your emails for a OTP"}') // send accountID
        } catch (err) {
            console.log(err)
            res.writeHead(500)
            res.end()
        }
        return;
    }
    if (urlPath == "/setPassword" && req.method == 'POST') {
        await getForm(req) // recieve accountID, OTP, new password
        let OTP = (OTPMap.get(req.body['accountID']))?.['resetPassword']
        if (!OTP || req.body['OTP'].length !== 6) {
            res.writeHead(401, {
                'Content-Type': 'text/plain'
            })
            res.end('Invalid Request')
            return;
        }
        if (OTP['expiration'] < new Date()) {
            res.writeHead(401, {
                'Content-Type': 'text/plain'
            })
            res.end('Invalid Request')
            return;
        }
        if (OTP['code'] !== req.body['OTP']) {
            OTP['attempts'] += 1
            if (OTP['attempts'] == MAX_OTP_ATTEMPTS) {
                OTP['code'] = undefined
            }
            res.writeHead(401, {
                'Content-Type': 'text/plain'
            })
            res.end('Invalid Request')
            return;
        }
        try {
            delete OTPMap.get(req.body['accountID'])['resetPassword']
            if (Object.keys(OTPMap.get(req.body['accountID'])).length == 0)
                OTPMap.delete(req.body['accountID'])
            req.body['password'] = await bcrypt.hash(req.body['password'], 12);
            let accountdb = mongoClient.db(database).collection('accounts')
            await accountdb.updateOne({ id: req.body['accountID'] }, { $set: { password: req.body['password'] } })
            res.writeHead(200)
            res.end()
        } catch (err) {
            console.log(err)
            res.writeHead(500)
            res.end()
        }
        return;
    }
    if (urlPath == "/logout" && req.method == 'POST') {
        try {
            let sessiondb = mongoClient.db(database).collection('sessions')
            if (cookies['sessionID'])
                sessiondb.deleteOne({ id: cookies['sessionID'] })
            sessionsCache.delete(cookies['sessionID'])
            res.writeHead(200, {
                'Set-Cookie': `sessionID=; Path=/; HttpOnly; Max-Age=0`
            })
            res.end()
        } catch (err) {
            console.log(err)
            res.writeHead(500)
            res.end()
        }
        return;
    }
    if (urlPath == '/issueAccount' && req.method == 'POST') {
        let sessiondb = mongoClient.db(database).collection('sessions')
        let accountdb = mongoClient.db(database).collection('accounts')
        let session = await sessiondb.findOne({ id: cookies['sessionID'], expiresAt: { $gt: new Date() } })
        let account = await accountdb.findOne({ id: session.accountID })
        if (account.role == 'admin') {
            await getForm(req)
            if (await accountdb.findOne({ email: req.body['email'] })) {
                res.writeHead(200)
                res.end('exists')
                return;
            }
            let accountID = generateID()
            while ((await accountdb.findOne({ id: accountID })))
                accountID = generateID()
            let verificationLink = generateID(64)
            let validity = new Date()
            validity.setHours(validity.getHours() + req.body['validity'] * 24)
            await accountdb.insertOne({ id: accountID, email: req.body['email'], verificationLink: verificationLink, validity: validity, verified: false, role: req.body['role'] })
            await mailServer.sendMail({
                from: 'No-Reply@themysticrealm.net',
                to: req.body['email'],
                subject: 'Account Creation Link',
                text: `https://themysticrealm.net/signup/${accountID}/${verificationLink}`
            })
        } else {
            res.writeHead(401)
            res.end()
        }
        return;
    }


    // ===============================================Blockchain voting logic===============================================
    // NOTE: /api/proposal and /api/vote (POST) were removed here.
    // Creating proposals and casting votes now happen entirely client-side
    // via MetaMask + ethers.js in the browser (see javascript/vote.js) -
    // this server no longer holds or touches any voter's private key.

    if (urlPath.startsWith("/api/proposals/") && req.method == 'GET') {
        try {
            const symbol = decodeURIComponent(urlPath.substring(15))
            const contract = new ethers.Contract(contractAddress, contractAbi, provider)
            const ids = await contract.getProposalsBySymbol(symbol)
            const proposals = await Promise.all(ids.map(async (id) => {
                const [sym, description, deadline, closed] = await contract.getProposal(id)
                return {
                    id: id.toString(),
                    description,
                    deadline: deadline.toString(),
                    closed,
                    active: !closed && (Date.now() / 1000) < Number(deadline)
                }
            }))
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, proposals }))
        } catch (err) {
            console.log(err)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, reason: 'Internal Server Error' }))
        }
        return;
    }

    if (urlPath.startsWith("/api/votes/") && req.method == 'GET') {
        try {
            const proposalId = urlPath.substring(11)
            const contract = new ethers.Contract(contractAddress, contractAbi, provider)
            const [symbol, description, deadline, closed] = await contract.getProposal(proposalId)
            const allEvents = await contract.queryFilter(contract.filters.VoteCast())
            const choiceLabels = ['NONE', 'HALAL', 'NOT HALAL', 'ABSTAIN']
            const votes = allEvents
                .filter(e => e.args[0].toString() === proposalId)
                .map(e => ({ voter: e.args[1], choice: choiceLabels[Number(e.args[2])] }))
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, description, closed, votes }))
        } catch (err) {
            console.log(err)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, reason: 'Internal Server Error' }))
        }
        return;
    }

    if (urlPath.startsWith("/api/tally/") && req.method == 'GET') {
        try {
            const proposalId = urlPath.substring(11)
            const contract = new ethers.Contract(contractAddress, contractAbi, provider)
            const [symbol, description, deadline, closed] = await contract.getProposal(proposalId)

            const votingStillOpen = !closed && (Date.now() / 1000) < Number(deadline)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            if (votingStillOpen) {
                res.end(JSON.stringify({ success: true, status: 'not yet tallied' }))
                return;
            }

            // Deadline has passed (or the proposal was formally closed on-chain) -
            // compute the tally directly from VoteCast events. This doesn't
            // require anyone to have called the contract's tally() function,
            // so results appear automatically the moment voting ends, with no
            // separate transaction/gas/manual action needed.
            const allEvents = await contract.queryFilter(contract.filters.VoteCast())
            const votesForThisProposal = allEvents.filter(e => e.args[0].toString() === proposalId)

            let halal = 0, notHalal = 0, abstain = 0
            for (const e of votesForThisProposal) {
                const choice = Number(e.args[2])
                if (choice === 1) halal++
                else if (choice === 2) notHalal++
                else if (choice === 3) abstain++
            }

            res.end(JSON.stringify({ success: true, halal: halal.toString(), notHalal: notHalal.toString(), abstain: abstain.toString() }))
        } catch (err) {
            console.log(err)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, reason: 'Internal Server Error' }))
        }
        return;
    }
    if (urlPath == "/api/translate_contract" && req.method == 'POST') {
        try {
            await getForm(req)
            const contractCode = req.body['contractCode'] || ''
            const translation = await aiTranslateContract(contractCode)
            res.writeHead(200, { "content-type": "text/plain" })
            res.end(translation)
        } catch (err) {
            console.log(err)
            res.writeHead(500, { 'Content-Type': 'text/plain' })
            res.end('Error 500: Internal Server Error')
        }
        return;
    }
    // Proxies JSON-RPC calls (from MetaMask, or ethers.js in the browser)
    // to Geth's local plain-HTTP RPC port. This reuses this server's
    // existing valid HTTPS certificate/domain/port - MetaMask requires
    // HTTPS for custom networks, but Geth itself only speaks plain HTTP,
    // so this route bridges the two without needing any separate reverse
    // proxy (Caddy, nginx, etc.) or a new subdomain/certificate.
    if (urlPath === '/rpc' && req.method === 'POST') {
        try {
            await parseBody(req)
            const proxyReq = http.request({
                hostname: '127.0.0.1',
                port: 8545,
                path: '/',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(req.body)
                }
            }, (proxyRes) => {
                let data = ''
                proxyRes.on('data', chunk => data += chunk)
                proxyRes.on('end', () => {
                    res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' })
                    res.end(data)
                })
            })
            proxyReq.on('error', (err) => {
                console.log('RPC proxy error:', err)
                res.writeHead(502, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'RPC proxy error - is Geth running on 127.0.0.1:8545?' } }))
            })
            proxyReq.write(req.body)
            proxyReq.end()
        } catch (err) {
            console.log(err)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Internal Server Error' } }))
        }
        return;
    }

    // Page handling (html, css, js, etc)
    let session = await getSession(cookies['sessionID'])
    let accountMenu
    if (session) {
        accountMenu = await fs.readFile(`./html/accountMenu/${session.role}.html`)
    } else {
        accountMenu = await fs.readFile('./html/accountMenu/default.html')
    }
    if (urlPath == "/" && req.method == 'GET') {
        try {
            let page = await fs.readFile('./html/index.html', 'utf8')
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(ejs.render(page, { 'list': JSON.stringify(cryptoCurrencies), 'accountMenu': accountMenu }))
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' })
            res.end('Internal Server Error')
        }
        return;
    }
    if (urlPath == "/login" && req.method == 'GET') {
        try {
            let page = await fs.readFile('./html/login.html', 'utf8')
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(ejs.render(page, { 'list': JSON.stringify(cryptoCurrencies), 'accountMenu': accountMenu }))
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' })
            res.end('Internal Server Error')
        }
        return;
    }
    if (urlPath == "/translate" && req.method == 'GET') {
        try {
            let page = await fs.readFile('./html/translate.html', 'utf8')
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(ejs.render(page, { 'list': JSON.stringify(cryptoCurrencies), 'accountMenu': accountMenu }))
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' })
            res.end('Internal Server Error')
        }
        return;
    }
    if (urlPath == "/signup" && req.method == 'GET') {
        try {
            let page = await fs.readFile('./html/signup.html', 'utf8')
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(ejs.render(page, { 'list': JSON.stringify(cryptoCurrencies), 'accountMenu': accountMenu }))
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' })
            res.end('Internal Server Error')
        }
        return;
    }
    if (urlPath == "/resetPassword" && req.method == 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(await fs.readFile(`./html/resetPassword.html`))
        return;
    }
    if (urlPath == "/vote" && req.method == 'GET') {
        try {
            let page = await fs.readFile('./html/vote.html', 'utf8')
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(ejs.render(page, {
                'list': JSON.stringify(cryptoCurrencies),
                'coin': queryParams.get('coin') || '',
                'contractAddress': contractAddress,
                'contractAbi': JSON.stringify(contractAbi),
                'publicRpcUrl': publicRpcUrl,
                'chainId': 15,
                'accountMenu': accountMenu
            }))
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' })
            res.end('Internal Server Error')
        }
        return;
    }
    if (urlPath == "/adminPanel" && req.method == 'GET') {
        let session = await getSession(cookies['sessionID'])
        if (session.role == 'admin') {
            try {
                let page = await fs.readFile('./html/adminPanel.html', 'utf8')
                res.writeHead(200, { 'Content-Type': 'text/html' })
                res.end(ejs.render(page, { 'list': JSON.stringify(cryptoCurrencies), 'accountMenu': accountMenu }))
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' })
                res.end('Internal Server Error')
            }
        }
        return;
    }


    // ===============================================Crypto currency query logic===============================================
    if (urlPath.startsWith("/coin/") && req.method == 'GET') {
        const coin_id = urlPath.substring(6)
        try {
            const cryptoTemplateDoc = await mongoClient.db(database).collection(collection).findOne({ title: coin_id })
            const template_data = {
                title: coin_id,
                status: cryptoTemplateDoc.status,
                usecases: cryptoTemplateDoc.usecases,
                list: JSON.stringify(cryptoCurrencies),
                'accountMenu': accountMenu
            }

            let html_file = await fs.readFile("./html/coin.html", "utf-8")
            let render = ejs.render(html_file, template_data)
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(render)
            return
        }
        // TO DO: Fix this
        catch (err) {
            console.log(`Error occurred while loading the cryptocurrency: ${coin_id}`)
            await makeCoin(coin_id)
        }
        res.writeHead(404, { 'Content-Type': 'text/html' })
        res.end()
        return;
    }

    if (urlPath.startsWith("/api/ai_summary")) {
        const coin = urlPath.substring(16)
        let coinSummary = await mongoClient.db(database).collection(collection).findOne({ title: coin })
        if (coinSummary.summaryDate < Date.now() - cacheSummaryEvery || coinSummary.summary == '') {
            try {
                coinSummary.summary = await aiSummarize(coin)
                await mongoClient.db(database).collection(collection).updateOne({ title: coin }, { $set: { summary: coinSummary.summary, summaryDate: new Date() } })
            }
            catch (err) {
                console.log("Error encountered while updating the AI summary: ")
                console.log(err)
            }
        }
        // let summary = await aiSummarize(coin)
        res.writeHead(200, { "content-type": "text/plain" })
        res.end(coinSummary.summary)
        return;
    }

    let file = req.url.split('/').pop()
    try {
        switch (true) {
            case file.endsWith(".html"):
                file = await fs.readFile(`./html/${file}`, 'utf-8')
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(file)
                return;
            case file.endsWith(".css"):
                file = await fs.readFile(`./css/${file}`, 'utf-8')
                res.writeHead(200, { 'Content-Type': 'text/css' });
                res.end(file);
                return;
            case file.endsWith(".png") || file.endsWith('.ico'):
                file = await fs.readFile(`./images/${file}`)
                res.writeHead(200, { 'Content-Type': 'image/png' });
                res.end(file);
                return;
            case file.endsWith(".js"):
                file = await fs.readFile(`./javascript/${file}`, 'utf-8')
                res.writeHead(200, { 'Content-Type': 'application/javascript' });
                res.end(file);
                return;
        }
    } catch (err) { }
    res.writeHead(404)
    res.end()
});

const httpServer = http.createServer(async (req, res) => {
    if (req.headers.host == '' || req.headers.host == '/')
        req.headers.host = 'undefined'
    console.log(`[${new Date().toLocaleString()}] [http]: [${req.socket.remoteAddress}] ${req.method} http://${req.headers.host}${req.url}`);
    if (req.url.startsWith("/.well-known/acme-challenge/") && fs.existsSync(`./.well-known/acme-challenge/${req.url.split('/').pop()}`)) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(fs.readFileSync(`./.well-known/acme-challenge/${req.url.split('/').pop()}`));
        return;
    }
    res.writeHead(404)
    res.end()
    return;
});

// MAIN
(async () => {
    await initializeDatabase()
    console.log('Database Initialized!')
    let cryptoList = mongoClient.db(database).collection(collection).find().project({ _id: 0, title: 1 })
    for await (const crypto of cryptoList) {
        cryptoCurrencies.push(crypto.title)
    }
    // Https Server
    server.listen(httpsPORT, '0.0.0.0', () => {
        console.log(`Server running at https://0.0.0.0:${httpsPORT}/`);
    });
    // Http Server
    httpServer.listen(httpPORT, '0.0.0.0', () => {
        console.log(`Server running at http://0.0.0.0:${httpPORT}/`)
    })
})()