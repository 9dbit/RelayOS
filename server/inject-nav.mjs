import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve('dist');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)])}
if(fs.existsSync(root))for(const file of walk(root)){if(!file.endsWith('.html'))continue;let html=fs.readFileSync(file,'utf8');const scripts=[];if(!html.includes('/relay-nav.js'))scripts.push('<script src="/relay-nav.js"></script>');if(!html.includes('/relay-command.js'))scripts.push('<script src="/relay-command.js"></script>');if(!scripts.length)continue;const block=scripts.join('');html=html.includes('</body>')?html.replace('</body>',block+'</body>'):html+'\n'+block+'\n';fs.writeFileSync(file,html)}
console.log('RelayOS unified navigation + AI command center injected into HTML build output');