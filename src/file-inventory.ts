import {readdirSync,lstatSync} from 'node:fs';
import {join} from 'node:path';

export function regularFiles(root:string,prefix='',singleLink=true):string[]{
 const result:string[]=[];
 for(const entry of readdirSync(join(root,prefix),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(prefix,entry.name),stat=lstatSync(join(root,path));if(stat.isDirectory()&&!stat.isSymbolicLink())result.push(...regularFiles(root,path,singleLink));else if(stat.isFile()&&!stat.isSymbolicLink()&&(stat.nlink===1||!singleLink))result.push(path);else throw Error(`EVAL_UNSAFE_FILE: ${path}`);if(result.length>20000)throw Error('EVAL_FILE_LIMIT');}
 return result;
}
