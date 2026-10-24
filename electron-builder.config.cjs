const packageJson = require('./package.json');

const distribution = String(process.env.BANKAPI_DISTRIBUTION || 'client').toLowerCase();
const isServer = distribution === 'server';
const base = packageJson.build;
const serverResources = [
  {
    from: '.packaging/backend.tar',
    to: 'backend.tar',
  },
  {
    from: '.packaging/server.marker',
    to: 'server.marker',
  },
];

module.exports = {
  ...base,
  compression: isServer ? 'store' : 'normal',
  extraResources: isServer ? serverResources : [],
  directories: {
    ...base.directories,
    output: `release-build/${distribution}`,
  },
  win: {
    ...base.win,
    compression: isServer ? 'store' : 'normal',
  },
  nsis: {
    ...base.nsis,
    artifactName: isServer
      ? 'BankApi Servidor Setup.exe'
      : 'BankApi Cliente Setup.exe',
  },
};
