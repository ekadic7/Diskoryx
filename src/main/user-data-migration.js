const fs = require('node:fs');
const path = require('node:path');

function copyProfileDirectory(source, destination) {
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error(`Expected a regular settings directory at ${source}.`);
  }
  fs.mkdirSync(destination);
  for (const name of fs.readdirSync(source)) {
    const sourcePath = path.join(source, name);
    const destinationPath = path.join(destination, name);
    const entryStat = fs.lstatSync(sourcePath);
    if (entryStat.isSymbolicLink()) throw new Error(`Refusing to migrate a symbolic link: ${sourcePath}.`);
    if (entryStat.isDirectory()) copyProfileDirectory(sourcePath, destinationPath);
    else if (entryStat.isFile()) fs.copyFileSync(sourcePath, destinationPath);
    else throw new Error(`Refusing to migrate an unsupported profile entry: ${sourcePath}.`);
  }
}

function migrateUserData(previousDirectory, currentDirectory) {
  if (fs.existsSync(currentDirectory) || !fs.existsSync(previousDirectory)) return false;

  const previousStat = fs.lstatSync(previousDirectory);
  if (previousStat.isSymbolicLink() || !previousStat.isDirectory()) {
    throw new Error(`The previous settings location is not a regular directory: ${previousDirectory}.`);
  }

  const historySource = path.join(previousDirectory, 'action-history.json');
  const storageSource = path.join(previousDirectory, 'Local Storage');
  const hasHistory = fs.existsSync(historySource);
  const hasStorage = fs.existsSync(storageSource);
  if (!hasHistory && !hasStorage) return false;

  const stagingDirectory = fs.mkdtempSync(`${currentDirectory}.migration-`);
  try {
    if (hasHistory) {
      const historyStat = fs.lstatSync(historySource);
      if (historyStat.isSymbolicLink() || !historyStat.isFile()) {
        throw new Error(`Refusing to migrate an unexpected history file: ${historySource}.`);
      }
      fs.copyFileSync(historySource, path.join(stagingDirectory, 'action-history.json'));
    }
    if (hasStorage) {
      copyProfileDirectory(storageSource, path.join(stagingDirectory, 'Local Storage'));
    }
    fs.renameSync(stagingDirectory, currentDirectory);
    return true;
  } catch (error) {
    try {
      fs.rmSync(stagingDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Settings migration failed and its temporary copy remains at ${stagingDirectory}.`
      );
    }
    throw new Error(
      `Unable to copy the previous local settings and history. The original data remains untouched: ${error.message}`,
      { cause: error }
    );
  }
}

module.exports = { migrateUserData };
