#!/usr/bin/env node
/** All commands here are preparation or supplied-evidence processing. */
import { parseArgs } from 'node:util';
import { planTemplate, grantTemplate, acceptanceTemplate, dailyTemplate, reportTemplate, installationTemplate,
  fileRef, json, manifest, save, validate, freeze, attachSelf, report } from './core.mjs';
try {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(['kind', 'plan', 'grant', 'input', 'out'].map(k => [k, { type: 'string' }]).concat([['help', { type: 'boolean' }]])) });
  const need = k => { if (!v[k]) throw Error(`ARGUMENT_REQUIRED:${k}`); return v[k]; };
  const verb = positionals[0];
  if (!verb || v.help) console.log(`PREP only; no model, Terminal, VM or measurement launch.
template --kind plan|grant|installation|daily|report|acceptance --out NEW.json
ref --input FILE
validate --plan PLAN.json [--grant GRANT.json]
freeze --plan PLAN.json --grant GRANT.json --out NEW.json
attach-self --input DAILY_INPUT.json --out NEW_DIRECTORY
report --input REPORT_INPUT.json --out NEW.json
Future controlled execution has a separate measure.mjs entry. Templates authorize nothing.`);
  else if (verb === 'template') {
    const makers = { plan: planTemplate, grant: grantTemplate, installation: installationTemplate, daily: dailyTemplate, report: reportTemplate, acceptance: acceptanceTemplate };
    if (!makers[v.kind]) throw Error('TEMPLATE_KIND_REQUIRED');
    save(need('out'), makers[v.kind]()); console.log(JSON.stringify({ status: 'PREP_TEMPLATE_NOT_AUTHORIZED', output: v.out }));
  } else if (verb === 'ref') console.log(JSON.stringify(fileRef(need('input'))));
  else if (verb === 'validate') {
    const { status, issues, measurement } = validate(need('plan'), v.grant); console.log(JSON.stringify({ status, issues, measurement }, null, 2)); if (issues.length) process.exitCode = 2;
  } else if (verb === 'freeze') console.log(JSON.stringify(freeze(need('plan'), need('grant'), need('out')), null, 2));
  else if (verb === 'attach-self') console.log(JSON.stringify(attachSelf(need('input'), need('out')), null, 2));
  else if (verb === 'report') {
    const input = json(need('input')), value = report(v.input); save(need('out'), value, [manifest(input.candidateManifest)], [v.input]);
    console.log(JSON.stringify({ status: value.status, output: v.out, acceptance: value.acceptance.status }));
  } else throw Error('UNKNOWN_PREP_COMMAND');
} catch (error) { console.error(JSON.stringify({ status: 'BLOCKED', error: String(error.message) })); process.exitCode = 2; }
