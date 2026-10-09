import { storageUsage, previewCleanup, commitCleanup, readCleanup, archiveStorage, restoreArchive, migrateStorage, verifyArchive, unfixEvidence } from './storage.js';

export async function storageCommand(command:string|undefined,action:string|undefined,root:string,values:Record<string,unknown>) {
  if(command!=='storage')return false;
  const str=(key:string)=>typeof values[key]==='string'?values[key] as string:undefined;
  const required=(key:string)=>{const value=str(key);if(!value)throw Error(`USAGE: storage ${action} requires --${key}`);return value;};
  if(values.format!==undefined&&values.format!=='json'&&values.format!=='text')throw Error('USAGE: format is json or text');
  let result:unknown;
  switch(action??'usage') {
    case 'usage':result=await storageUsage(root,{after:str('after')?Number(str('after')):undefined,limit:str('limit')?Number(str('limit')):undefined});break;
    case 'preview':result=await previewCleanup(root,{id:required('id'),units:required('units').split(','),reason:required('reason')});break;
    case 'commit':{const outcome=await commitCleanup(root,{id:required('id'),identity:required('confirm')});result=outcome;if(outcome.status!=='completed')process.exitCode=75;break;}
    case 'status':result=readCleanup(root,required('id'));break;
    case 'archive':{const scope=required('scope');if(scope!=='whole-root'&&scope!=='attachments')throw Error('USAGE: scope is whole-root or attachments');result=await archiveStorage(root,{destination:required('destination'),scope,objects:str('objects')?.split(',')});break;}
    case 'restore':result=await restoreArchive(required('archive'),required('destination'));break;
    case 'verify':result=await verifyArchive(required('archive'));break;
    case 'migrate':result=await migrateStorage(root,{destination:required('destination'),backup:required('backup')});break;
    case 'unfix':result=await unfixEvidence(root,{id:required('id'),fixedEvidenceId:required('evidence'),reason:required('reason')});break;
    default:throw Error('USAGE: storage usage|preview|commit|status|archive|restore|verify|migrate|unfix');
  }
  console.log(str('format')==='text'?`pi-durio storage ${action??'usage'}\n${JSON.stringify(result,null,2)}`:JSON.stringify(result,null,2));return true;
}
