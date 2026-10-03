import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const path=resolve(process.argv[2]??'runs/report-overview-example-20261002/report.html');
const html=readFileSync(path);
const server=createServer((request,response)=>{
  if(request.url!=='/'&&request.url!=='/report.html'){response.writeHead(404);response.end('Preview serves only the report HTML.');return;}
  response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
  response.end(html);
});
server.listen(41827,'127.0.0.1',()=>console.log('Report preview: http://127.0.0.1:41827/report.html'));
