const fs = require('fs').promises;
const path = require('path');

const DIR_NAME = 'reports';

const updateDirs = async () => {
  try {
    await fs.rm(path.join(DIR_NAME), {recursive: true, force: true});
  } 
  catch(error) {
    if(error.code === 'ENOENT') {
      console.log('⚠️ Directory or file does not exist. No action needed.');
    } 
    else {
      console.error('❌ Error removing the file or directory:', error);
    }
  }
};

const addDirs = async (filterKey, filterValue) => {
  if(filterKey == 'date') {
    filterValue = filterValue.replace(/\//g, '-');
  }
  await Promise.all([
    fs.mkdir(path.join(DIR_NAME, filterValue, 'success'), { recursive: true }),
    fs.mkdir(path.join(DIR_NAME, filterValue, 'fail'), { recursive: true }),
  ]);
};

const writePage = async (directory, filterKey, filterValue, pageNumber, data) => {
  if(filterKey == 'date') {
    filterValue = filterValue.replace(/\//g, '-');
  }
  const filePath = path.join(DIR_NAME, filterValue, directory, `${filterValue}(${pageNumber}).json`);
  return fs.writeFile(filePath, JSON.stringify(data, null, 2));
};

const writeFinalFile = async (filterValue, finalMessage) => {
  try {
    await fs.writeFile(`${DIR_NAME}/final.txt`, `${filterValue}: ${finalMessage}`, {flag: 'a'});
  }
  catch (error) {
    console.error('Writing on final file encountered with an error: ', error);
  }
};

module.exports = {
  updateDirs,
  addDirs,
  writePage,
  writeFinalFile
};