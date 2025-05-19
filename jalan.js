const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');

const filesToDelete = ['.npm', '.git', 'core'];
const rootDir = __dirname;

function deleteUnwantedFiles() {
  filesToDelete.forEach(file => {
    const filePath = path.join(rootDir, file);
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { recursive: true, force: true });
      console.log(`Deleted: ${filePath}`);
    }
  });
}

function resetGameData() {
  const dbPath = path.join(__dirname, 'database', 'database.json');

  try {
    const data = fs.readFileSync(dbPath, 'utf8');
    const db = JSON.parse(data);

    if (db.game) {
      delete db.game;
      console.log('Objek "game" berhasil dihapus dari database.json.');
    } else {
      console.log('Objek "game" tidak ditemukan di database.json.');
    }

    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
    console.log('database.json berhasil diperbarui.');

  } catch (err) {
    console.error('Terjadi kesalahan saat mereset data game:', err);
  }
}

deleteUnwantedFiles();

resetGameData();

chokidar.watch('.', { ignored: /node_modules|\.git/, ignoreInitial: true })
  .on('all', () => {
    deleteUnwantedFiles();
  });

console.log('Chokidar is watching for file changes...');

