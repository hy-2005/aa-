// One-shot: write the correct WHISPER_COMMAND into the userData .env.
const fs = require('fs');
const path = require('path');

const envPath = path.join(process.env.APPDATA, 'opencluely', '.env');
const venvPython = path.join(process.env.APPDATA, 'opencluely', '.venv-whisper', 'Scripts', 'python.exe');

if (!fs.existsSync(venvPython)) {
  console.error('venv python not found:', venvPython);
  process.exit(1);
}

let env = fs.readFileSync(envPath, 'utf8');
const line = `WHISPER_COMMAND=${venvPython} -m whisper`;
if (/^WHISPER_COMMAND=.*$/m.test(env)) {
  env = env.replace(/^WHISPER_COMMAND=.*$/m, line);
} else {
  env = env.trimEnd() + '\n' + line + '\n';
}
fs.writeFileSync(envPath, env, 'utf8');
console.log('written:', line);
console.log('verify:', fs.readFileSync(envPath, 'utf8').match(/^WHISPER_COMMAND=.*$/m)[0]);
