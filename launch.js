// Starts Electron even from VS Code's terminal, which sets ELECTRON_RUN_AS_NODE.
// `node launch.js` runs the app; `node launch.js some-script.js` runs that script in Electron.
const { spawn } = require('child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2);
const child = spawn(electron, args.length ? args : ['.'], { stdio: 'inherit', env, cwd: __dirname });
child.on('close', (code) => process.exit(code ?? 0));
