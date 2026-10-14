import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** UI text only. A draft is never an accepted task, queue entry, or authority to execute. */
export class Drafts {
  private readonly prefix: string;
  private readonly file: string;
  constructor(private readonly root: string, workspace: string, dataRoot: string) {
    this.prefix = createHash('sha256').update(JSON.stringify([workspace,dataRoot])).digest('hex');
    this.file = `${this.prefix}-${Date.now()}-${randomUUID()}.json`;
  }
  save(text: string) {
    if (!text) return;
    if (Buffer.byteLength(text) > 32768) throw new Error('DRAFT_LIMIT');
    mkdirSync(this.root, {recursive:true,mode:0o700});
    const path=join(this.root,this.file), temp=`${path}.${randomUUID()}`;
    const fd=openSync(temp,'wx',0o600);
    try { writeFileSync(fd,JSON.stringify({text,savedAt:new Date().toISOString(),state:'draft-only'})); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp,path);
    const dir=openSync(this.root,'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  /** Raw input events that never reached the editor. Never restored or replayed as commands. */
  savePending(inputs:Array<{data:string;context:string}>,reason:string) {
    if(!inputs.length)return;
    const root=join(this.root,'pending-input');mkdirSync(root,{recursive:true,mode:0o700});
    const path=join(root,`${this.prefix}-${Date.now()}-${randomUUID()}.json`);
    const fd=openSync(path,'wx',0o600);
    try {writeFileSync(fd,JSON.stringify({state:'not_applied',reason,inputs,savedAt:new Date().toISOString(),automaticReplay:false}));fsyncSync(fd);}finally{closeSync(fd);}
    const dir=openSync(root,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
  }
  latest(): string | undefined {
    let names:string[];
    try { names=readdirSync(this.root); } catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT') return; throw error; }
    const name=names.filter(n=>n.startsWith(`${this.prefix}-`) && n.endsWith('.json')).sort().at(-1);
    if (!name) return;
    const stored=readFileSync(join(this.root,name));
    if(stored.length>65536) throw new Error('DRAFT_CORRUPT');
    const parsed=JSON.parse(stored.toString());
    if(typeof parsed.text!=='string' || Buffer.byteLength(parsed.text)>32768 || parsed.state!=='draft-only') throw new Error('DRAFT_CORRUPT');
    return parsed.text;
  }
}
