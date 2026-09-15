import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const port = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

app.use(express.json({ limit: '2mb' }));
app.get('/api/health', (_req,res)=>res.json({ok:true,service:'RelayOS',timestamp:new Date().toISOString()}));
app.get('/api/v1/numbers', (_req,res)=>res.json({items:[
  {id:'wa-01',name:'Sales Jakarta 01',phone:'6281210002201',health:96,status:'healthy'},
  {id:'wa-02',name:'Sales Jakarta 02',phone:'6281210002202',health:92,status:'healthy'},
  {id:'wa-03',name:'Support 01',phone:'6281310003301',health:88,status:'healthy'},
  {id:'wa-04',name:'VIP Desk',phone:'6281410004401',health:73,status:'attention'}
]}));
app.use(express.static(path.join(root,'dist')));
app.get('*', (_req,res)=>res.sendFile(path.join(root,'dist','index.html')));
app.listen(port,'0.0.0.0',()=>console.log(`RelayOS listening on ${port}`));
