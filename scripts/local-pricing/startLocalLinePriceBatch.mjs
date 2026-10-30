import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const dir=path.resolve(root,process.argv.find(a=>a.startsWith('--dir='))?.slice(6)||'.local-pricing/ll-publication');
fs.mkdirSync(dir,{recursive:true,mode:0o700});
const log=fs.openSync(path.join(dir,'progress.log'),'a',0o600);
const child=spawn('/usr/bin/caffeinate',['-is',process.execPath,'--env-file=.env','apps/api/scripts/publishLocalLinePrices.js',`--dir=${dir}`,'--apply'],{
  cwd:root,detached:true,stdio:['ignore',log,log],env:{...process.env,LOCALLINE_DASHBOARD_ENV_PATH:'/dev/null'}
});
await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
fs.writeFileSync(path.join(dir,'launcher.json'),JSON.stringify({pid:child.pid,startedAt:new Date().toISOString(),directory:dir},null,2),{mode:0o600});
child.unref();fs.closeSync(log);
console.log(`Local Line-only batch started (sleep-prevention process ${child.pid}).\nProgress: ${path.join(dir,'summary.txt')}\nKeep the laptop plugged in with the lid open. Resume with the same command and directory after interruption.`);
