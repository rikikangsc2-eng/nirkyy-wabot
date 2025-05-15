require('./jalan.js');
require('./settings');
const fs = require('fs');
const pino = require('pino');
const path = require('path');
const axios = require('axios');
const chalk = require('chalk');
const express = require('express');
const readline = require('readline');
const { createServer } = require('http');
const { Boom } = require('@hapi/boom');
const NodeCache = require('node-cache');
const { toBuffer } = require('qrcode');
const { exec, execSync } = require('child_process');
const { parsePhoneNumber } = require('awesome-phonenumber');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    Browsers,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    proto
} = require('baileys');
const { makeInMemoryStore } = require('@whiskeysockets/baileys/lib/Store'); // Perbaikan utama di sini

const { GroupCacheUpdate, GroupParticipantsUpdate, MessagesUpsert, Solving } = require('./src/message');
const { sleep } = require('./lib/function');
const DataBase = require('./src/database');
const packageInfo = require('./package.json');

const pairingCode = process.argv.includes('--qr') ? false : process.argv.includes('--pairing-code') || global.pairing_code;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));
let app = express();
let server = createServer(app);
let PORT = process.env.PORT || process.env.SERVER_PORT || 3000;
let pairingStarted = false;
let presenceInterval = null;
let fatalRetryCount = 0;

global.fetchApi = async (path = '/', query = {}, options) => {
    const urlnya = (options?.name || options ? ((options?.name || options) in global.APIs ? global.APIs[(options?.name || options)] : (options?.name || options)) : global.APIs['hitori'] ? global.APIs['hitori'] : (options?.name || options)) + path + (query ? '?' + decodeURIComponent(new URLSearchParams(Object.entries({ ...query }))) : '');
    const { data } = await axios.get(urlnya, { ...((options?.name || options) ? {} : { headers: { 'accept': 'application/json', 'x-api-key': global.APIKeys[global.APIs['hitori']] } }) });
    return data;
};

const database = new DataBase(global.tempatDB);
const msgRetryCounterCache = new NodeCache();
const groupCache = new NodeCache({ stdTTL: 5 * 60, useClones: false });

app.get('/', (req, res) => {
    if (process.send) {
        process.send('uptime');
        process.once('message', (uptime) => {
            res.json({
                bot_name: packageInfo.name,
                version: packageInfo.version,
                author: packageInfo.author,
                description: packageInfo.description,
                uptime: `${Math.floor(uptime)} seconds`
            });
        });
    } else {
        res.json({ error: 'Process not running with IPC' });
    }
});

server.listen(PORT, () => {
    console.log('App listened on port', PORT);
});

async function startNazeBot() {
    const store = makeInMemoryStore({ logger: pino().child({ level: 'silent', stream: 'store' }) });
    const { state, saveCreds } = await useMultiFileAuthState('nazedev');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    const logger = pino({ level: 'silent' }); // Menggunakan logger yang sama dengan store atau buat instance baru

    try {
        const loadData = await database.read();
        if (loadData && Object.keys(loadData).length === 0) {
            global.db = {
                hit: {},
                set: {},
                users: {},
                game: {},
                groups: {},
                database: {},
                premium: [],
                sewa: [],
                ...(loadData || {}),
            };
            await database.write(global.db);
        } else {
            global.db = loadData;
        }

        setInterval(async () => {
            if (global.db) await database.write(global.db);
        }, 30 * 1000);
    } catch (e) {
        console.error('Error loading/initializing database:', e);
        process.exit(1);
    }

    const getMessage = async (key) => {
        if (store) {
            const msg = await store.loadMessage(key.remoteJid, key.id);
            return msg?.message || undefined; // Kembalikan undefined jika tidak ada, sesuai contoh Baileys
        }
        return proto.Message.fromObject({}); // Fallback minimal jika store tidak ada
    };

    const naze = makeWASocket({ // Perubahan WAConnection ke makeWASocket
        logger,
        version, // Menambahkan version dari fetchLatestBaileysVersion
        printQRInTerminal: !pairingCode,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        msgRetryCounterCache,
        getMessage,
        syncFullHistory: true,
        maxMsgRetryCount: 15,
        retryRequestDelayMs: 10,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: undefined,
        browser: Browsers.ubuntu('Chrome'),
        generateHighQualityLinkPreview: true,
        cachedGroupMetadata: async (jid) => groupCache.get(jid),
        transactionOpts: {
            maxCommitRetries: 10,
            delayBetweenTriesMs: 10,
        },
        appStateMacVerification: {
            patch: true,
            snapshot: true,
        }
    });

    store.bind(naze.ev);
    await Solving(naze, store);
    naze.ev.on('creds.update', saveCreds);

    naze.ev.on('connection.update', async (update) => {
        const { qr, connection, lastDisconnect, isNewLogin, receivedPendingNotifications } = update;

        if ((connection === 'connecting' || !!qr) && pairingCode && !naze.authState.creds.registered && !pairingStarted) {
            pairingStarted = true;
            let phoneNumber;
            async function getPhoneNumber() {
                phoneNumber = global.number_bot ? global.number_bot : await question('Please type your WhatsApp number : ');
                phoneNumber = phoneNumber.replace(/[^0-9]/g, '');

                if (!parsePhoneNumber(phoneNumber).valid && phoneNumber.length < 6) {
                    console.log(chalk.bgBlack(chalk.redBright('Start with your Country WhatsApp code') + chalk.whiteBright(',') + chalk.greenBright(' Example : 62xxx')));
                    await getPhoneNumber();
                }
            }

            setTimeout(async () => {
                await getPhoneNumber();
                console.log('Requesting Pairing Code...');
                await sleep(5000);
                try {
                    let code = await naze.requestPairingCode(phoneNumber);
                    console.log(`Your Pairing Code : ${code}`);
                } catch (e) {
                    console.error("Failed to request pairing code:", e);
                    console.log("Please restart the process.");
                    pairingStarted = false;
                }
            }, 3000);
        }

        if (connection === 'close') {
            if (presenceInterval) {
                clearInterval(presenceInterval);
                presenceInterval = null;
                console.log('Presence update interval stopped.');
            }

            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode || 500;
            const reasonText = DisconnectReason[reason] || `Unknown (${reason})`;
            console.log(chalk.yellow(`Connection closed, reason: ${reasonText}.`));

            const isFatalReason = [
                DisconnectReason.loggedOut,
                DisconnectReason.forbidden,
                DisconnectReason.multideviceMismatch,
                DisconnectReason.badSession
            ].includes(reason);

            if (isFatalReason) {
                fatalRetryCount++;
                console.log(chalk.yellow(`Fatal reason detected. Retry attempt ${fatalRetryCount} of 3.`));
                if (fatalRetryCount >= 3) {
                    console.log(chalk.red(`Maximum fatal retries reached (${reasonText}). Deleting session and exiting...`));
                    try {
                        execSync('rm -rf ./nazedev'); // Hapus folder sesi
                    } catch (rmErr) {
                        console.error("Error removing session directory:", rmErr);
                    }
                    process.exit(1);
                } else {
                    console.log(`Waiting 5 seconds before attempting fatal reconnect #${fatalRetryCount + 1}...`);
                    await sleep(5000);
                    startNazeBot();
                }
            } else {
                fatalRetryCount = 0;
                console.log(`Non-fatal disconnection. Waiting 5 seconds before reconnecting...`);
                await sleep(5000);
                startNazeBot();
            }
        }

        if (connection === 'open') {
            console.log(chalk.green('Connected to WhatsApp! User:'), JSON.stringify(naze.user?.name || naze.user?.id));
            fatalRetryCount = 0;
            let botNumber = naze.decodeJid(naze.user.id);
            pairingStarted = false;

            if (global.db?.set[botNumber] && !global.db?.set[botNumber]?.join && global.my && global.my.ch) {
                if (global.my.ch.length > 0 && global.my.ch.includes('@newsletter')) {
                    if (global.my.ch) await naze.newsletterUpdateSubscription(global.my.ch, 'subscribe').catch(e => { console.error("Error subscribing to newsletter:", e); });
                    global.db.set[botNumber].join = true;
                }
            }

            if (!presenceInterval) {
                console.log('Starting presence update interval...');
                presenceInterval = setInterval(() => {
                    if (naze.ws?.socket?.readyState === 1) {
                        naze.sendPresenceUpdate('available', botNumber);
                    }
                }, 15 * 60 * 1000);
            }
        }

        if (qr && !pairingCode) {
            console.log(chalk.yellow('Scan the QR code below:'));
            app.use('/qr', async (req, res) => {
                res.setHeader('content-type', 'image/png');
                res.end(await toBuffer(qr));
            });
            console.log(chalk.blue(`QR available at http://localhost:${PORT}/qr or scan in terminal if displayed.`));
        }
        if (qr && pairingCode) {
            console.log(chalk.yellow("Waiting for Pairing Code input... QR generated but pairing code method is active."));
        }

        if (isNewLogin) console.log(chalk.green('New device login detected...'));
        if (receivedPendingNotifications) { // receivedPendingNotifications adalah boolean
            console.log(chalk.yellow('Receiving pending notifications, please wait...'));
        }
    });

    naze.ev.on('contacts.update', (update) => {
        for (let contact of update) {
            let id = naze.decodeJid(contact.id);
            if (store && store.contacts) store.contacts[id] = { id, name: contact.notify };
        }
    });

    naze.ev.on('call', async (call) => {
        let botNumber = naze.decodeJid(naze.user.id);
        if (global.db?.set[botNumber]?.anticall) {
            for (let id of call) {
                if (id.status === 'offer') {
                    console.log(chalk.red(`Incoming ${id.isVideo ? 'video' : 'audio'} call from ${id.from}, rejecting...`));
                    let ownerNum = (Array.isArray(global.owner) && global.owner.length > 0 ? global.owner[0] : '1234567890') + '@s.whatsapp.net';
                    let msgText = `Maaf, bot tidak dapat menerima panggilan ${id.isVideo ? 'video' : 'suara'}.\nJika Anda butuh bantuan, silakan chat owner @${ownerNum.split('@')[0]}`;
                    let msg = await naze.sendMessage(id.from, { text: msgText, mentions: [id.from, ownerNum] });
                    await naze.sendContact(id.from, global.owner || [], msg); // Perlu array of strings untuk nomor kontak
                    await naze.rejectCall(id.id, id.from);
                }
            }
        }
    });

    naze.ev.on('messages.upsert', async (message) => {
        await MessagesUpsert(naze, message, store, groupCache);
    });

    naze.ev.on('groups.update', async (update) => {
        await GroupCacheUpdate(naze, update, store, groupCache);
    });

    naze.ev.on('group-participants.update', async (update) => {
        await GroupParticipantsUpdate(naze, update, store, groupCache);
    });

    return naze;
}

startNazeBot().catch(err => {
    console.error("Error starting bot:", err);
    process.exit(1);
});

process.on('exit', async (code) => {
    console.log(`Exiting with code: ${code}`);
    if (global.db) {
        console.log('Saving database before exit...');
        await database.write(global.db).catch(e => console.error("Error saving database on exit:", e));
    }
    console.log('Cleaning up... Closing server.');
    server.close(() => {
        console.log('Server closed.');
    });
    if (presenceInterval) clearInterval(presenceInterval);
});

process.on('SIGINT', async () => {
    console.log('Received SIGINT. Shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('Received SIGTERM. Shutting down gracefully...');
    process.exit(0);
});

process.on('uncaughtException', (err, origin) => {
    console.error(`Uncaught Exception: ${err.message}`);
    console.error(`Origin: ${origin}`);
    console.error(err.stack);
    // Pertimbangkan untuk keluar dari proses di sini setelah logging, agar PM2 bisa me-restart
    // process.exit(1); 
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise);
    console.error('Reason:', reason);
    // Sama seperti uncaughtException, pertimbangkan untuk keluar
    // process.exit(1);
});

server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error(chalk.red(`Error: Address localhost:${PORT} is already in use. Please ensure no other process is using this port.`));
        server.close();
        process.exit(1);
    } else {
        console.error('Server error:', error);
    }
});

let file = require.resolve(__filename);
fs.watchFile(file, () => {
    fs.unwatchFile(file);
    console.log(chalk.yellowBright(`File updated: ${__filename}. Reloading...`));
    delete require.cache[file];
    process.exit(0);
});