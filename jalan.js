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

deleteUnwantedFiles();

chokidar.watch('.', { ignored: /node_modules|\.git/, ignoreInitial: true })
  .on('all', () => {
    deleteUnwantedFiles();
  });

console.log('Chokidar is watching for file changes...');
