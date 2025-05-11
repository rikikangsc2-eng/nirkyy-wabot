const { exec, spawn } = require('child_process');
const path = require('path');

const scriptName = 'index.js';
const processName = 'NirKyy';
const maxMemory = '800M';

const scriptPath = path.resolve(__dirname, scriptName);
const startCommand = `npx pm2 start ${scriptPath} --name ${processName} --max-memory-restart ${maxMemory}`;

console.log(`Mencoba menjalankan: ${startCommand}`);

const startProcess = exec(startCommand, (startError, startStdout, startStderr) => {
    if (startError) {
        console.error(`\n[ERROR] Gagal menjalankan pm2 start: ${startError.message}`);
        if (startStderr) console.error(`Stderr: ${startStderr}`);
        process.exitCode = 1;
        return;
    }

    if (startStdout) {
        console.log(`\n[PM2 Start Output] Stdout:\n${startStdout}`);
    }
    if (startStderr) {
        console.warn(`\n[PM2 Start Output] Stderr:\n${startStderr}`);
    }

    console.log(`\nProses '${processName}' telah dimulai atau diperbarui oleh PM2.`);
    console.log(`Memulai streaming log untuk '${processName}'... (Tekan Ctrl+C untuk berhenti)`);

    // Gunakan spawn untuk streaming log
    const logCommand = 'npx';
    const logArgs = ['pm2', 'logs', processName, '--raw']; // --raw lebih cocok untuk streaming programatik

    const logProcess = spawn(logCommand, logArgs, {
        stdio: ['ignore', 'pipe', 'pipe'] // stdin diabaikan, tangkap stdout & stderr
    });

    // Pipa output log ke konsol utama
    logProcess.stdout.pipe(process.stdout);
    logProcess.stderr.pipe(process.stderr);

    logProcess.on('error', (logSpawnError) => {
        console.error(`\n[ERROR] Gagal memulai streaming log: ${logSpawnError.message}`);
        process.exitCode = 1;
    });

    logProcess.on('close', (code) => {
        console.log(`\nStreaming log untuk '${processName}' berhenti dengan kode: ${code}`);
        // Skrip akan keluar secara alami setelah proses log berhenti
    });

    // Pastikan proses log berhenti jika skrip utama dihentikan paksa
    process.on('SIGINT', () => {
        console.log('\nMenghentikan streaming log...');
        logProcess.kill('SIGINT'); // Kirim sinyal interupsi ke proses log
        // Beri waktu sedikit sebelum keluar paksa jika perlu
        setTimeout(() => process.exit(0), 500);
    });
});

// Tidak perlu secara eksplisit menjaga skrip tetap berjalan,
// karena proses 'spawn' untuk log akan menjaganya tetap aktif.