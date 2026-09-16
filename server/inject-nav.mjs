import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve('dist');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)])}
if(fs.existsSync(root))for(const file of walk(root)){if(!file.endsWith('.html'))continue;let html=fs.readFileSync(file,'utf8');if(html.includes('/relay-nav.js'))continue;html=html.includes('</body>')?html.replace('</body>','<script src="/relay-nav.js"></script></body>'):html+'\n<script src="/relay-nav.js"></script>\n';fs.writeFileSync(file,html)}
console.log('RelayOS unified navigation injected into HTML build output');