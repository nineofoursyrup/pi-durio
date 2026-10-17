#!/usr/bin/env node
/** Every subcommand is PREP/offline. There is deliberately no run/launch verb. */
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {planTemplate,grantTemplate,caseTemplate,observationTemplate,fileRef,save,validate,publicValidation,freeze,commands,report,checkWorkspace} from './core.mjs';

try{
 const {values,positionals}=parseArgs({allowPositionals:true,options:{kind:{type:'string'},path:{type:'string'},plan:{type:'string'},grant:{type:'string'},frozen:{type:'string'},input:{type:'string'},out:{type:'string'},help:{type:'boolean'}}});
 const verb=positionals[0];
 if(values.help||!verb){
  console.log('PREP only: no credential lookup, product import, Terminal/VM start or model dispatch.\n'+
   'template --kind plan --path coding|improve|eval --out NEW.json\n'+
   'template --kind grant|cases|observations --out NEW.json\n'+
   'ref --input FILE.json\n'+
   'check-workspace --plan PLAN.json\n'+
   'validate --plan PLAN.json [--grant GRANT.json]\n'+
   'freeze --plan PLAN.json --grant GRANT.json --out NEW.json\n'+
   'commands --frozen FROZEN.json --out NEW.json\n'+
   'report --input OBSERVATIONS.json --out NEW.json');
 }else{
  const need=key=>{if(!values[key])throw Error(`ARGUMENT_REQUIRED: --${key}`);return resolve(values[key]);};
  let value;
  if(verb==='template'){
   value=values.kind==='plan'?planTemplate(values.path):values.kind==='grant'?grantTemplate():values.kind==='cases'?caseTemplate():values.kind==='observations'?observationTemplate():undefined;
   if(!value)throw Error('TEMPLATE_KIND_REQUIRED');save(need('out'),value);console.log(JSON.stringify({status:'TEMPLATE_NOT_AUTHORIZED',output:values.out}));
  }else if(verb==='ref')console.log(JSON.stringify(fileRef(need('input'))));
  else if(verb==='check-workspace')console.log(JSON.stringify(checkWorkspace(need('plan')),null,2));
  else if(verb==='validate'){
   value=publicValidation(validate(need('plan'),values.grant&&resolve(values.grant)));console.log(JSON.stringify(value,null,2));if(value.issues.length)process.exitCode=2;
  }else if(verb==='freeze'){
   value=freeze(need('plan'),need('grant'),need('out'));console.log(JSON.stringify({status:value.status,output:values.out}));
  }else if(verb==='commands'||verb==='report'){
   value=verb==='commands'?commands(need('frozen')):report(need('input'));save(need('out'),value);console.log(JSON.stringify({status:verb==='commands'?value.status:'EVIDENCE_INDEX_WRITTEN',output:values.out}));
  }else throw Error('UNKNOWN_PREP_COMMAND');
 }
}catch(error){console.error(JSON.stringify({status:'BLOCKED',error:String(error.message)}));process.exitCode=2;}
