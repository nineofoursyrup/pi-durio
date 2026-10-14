#!/usr/bin/env python3
"""Render derivative reports from already-collected facts only."""
import hashlib
import json
from pathlib import Path

out=Path(__file__).resolve().parent
b=out.parent
facts=json.loads((out/'observed-facts.json').read_text())
def identity(path):
 data=path.read_bytes()
 return {'path':str(path),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
def save(name,value):
 with (out/name).open('x') as f:
  json.dump(value,f,ensure_ascii=False,indent=2);f.write('\n')
def md(name,text):
 with (out/name).open('x') as f:f.write(text)

timeline=[]
for entry in facts['improve']['timeline']:
 s,d=entry['source'],entry['data']
 if s['seq'] in [67,69,88,89,90,91,93,94,95,97,100,101,102,103,110,111]:
  if s['kind']=='tool.result': d={'attemptId':d['attemptId'],'completeness':d.get('completeness'),'resultIsError':d.get('result',{}).get('isError',False),'summaryRetainedAtSeq':94}
  elif s['kind']=='improve.summary':d={'target':d['target'],'cutoff':d['cutoff'],'sourceTargets':[{k:t.get(k) for k in ['id','state','baseline','applicableVersion','gaps']} for t in d['targets']],'registeredProjectFiles':len(d['targets'][0]['files'])}
  elif s['kind']=='improve.report':d={k:d.get(k) for k in ['id','revision','state','candidates','selected','reason','budget','gaps']}
  timeline.append({'source':s,'data':d})
requests=[]
for r in facts['eval']['requests']+facts['improve']['requests']:
 entry={k:v for k,v in r.items() if k!='rawChunkSources'}
 entry['rawFirstChunk']=r['rawChunkSources'][0]
 entry['rawLastChunk']=r['rawChunkSources'][-1]
 requests.append(entry)
report={
 'status':'STOPPED_NO_EXECUTABLE_CHAIN','failureId':'LIVE-USD3-R3-01',
 'scope':'Read-only result readback and diagnosis; no product execution, provider, VM, credential access, replay, fix, selection or writeback',
 'candidate':facts['product'],'manifest':facts['manifest'],
 'summary':'Three supplemental coding trials PASS. Actual improve failed after its first successful HTTP 200 tool-call stream: acquired terminal usage and DONE were followed by consumer cancel, which the product settled as UNKNOWN; the second generation was blocked before dispatch.',
 'start':{k:v for k,v in facts['paidStart'].items() if k not in ['credentialSource','credentialValue']},
 'batchResult':facts['batchResult'],'codingTrials':facts['eval']['trials'],'newPhysicalRequests':requests,
 'improve':{'reportId':facts['improve']['originalResult']['improve']['id'],'revision':facts['improve']['originalResult']['improve']['revision'],
            'runId':facts['improve']['runId'],'state':'incomplete','reason':'BUDGET_UNKNOWN_USAGE','candidates':0,'selection':'none',
            'sdkUsage':facts['improve']['originalResult']['usage'],'originalHostBudget':facts['improve']['originalResult']['improve']['budget'],
            'reopenedReportMatchesExactly':True,'reopenedRunResultDifference':'Only persisted run.closed clock metadata is added; other fields exactly match returned result',
            'timeline':timeline,'fixtureFiles':facts['improve']['fixtureFiles'],
            'selectionPackage':'UNAVAILABLE: zero candidates. No candidate deterministic check, activation or writeback was run.'},
 'accounting':facts['accounting'],'originalFailurePreserved':facts['originalFailurePreserved'],'codeBindings':facts['codeBindings'],
 'rootCause':{'classification':'PROVEN_PRODUCT_DEFECT','title':'Normal SSE completion consumer cancel discards observed terminal usage',
              'evidence':'Raw last chunk and model.provider-event contain usage 923+29=952 plus DONE before budget.settle null/cancelled; SDK response succeeds, evidence_summary succeeds, next dispatch is refused locally.',
              'mechanism':'Product parses usage but only settles it at transport EOF. The installed OpenAI SSE iterator stops at DONE and cancels its reader before EOF. Product cancel ignores parsed usage and always settles null.',
              'affected':'Actual #23 improve path discovered by #30; historical offline acceptance is retained with its original time/candidate/scope. Current real acceptance remains incomplete.',
              'notEstablished':'No credential/provider auth fault, transport outage, model tool misuse, evidence_summary rejection, budget exhaustion or request-limit failure is evidenced here. SDK Connection error is the surface error of a pre-dispatch local refusal.',
              'repairProposal':'Recognize an acquired valid terminal SSE response and usage when distinguishing normal consumer closure from genuine cancellation; keep incomplete/aborted/error/missing-usage cases UNKNOWN and the old ledger immutable. Main owns any implementation/review/new-candidate decision.'},
 'identityAndReadback':{'originalInputsRehashed':facts['originalsVerifiedUnchanged'],'priorR2InputsRehashed':facts['originalFailurePreserved']['priorReadIdentitiesVerified'],
                       'singleStartEvidence':'One paid-start receipt; one eval.started; one new improve.started/run.started; no other provider.dispatch run IDs in either r3 database. Pre-existing improve seed run has no provider.dispatch.',
                       'scopeLimit':'Journal observations bind these retained roots; no claim about unrelated processes/accounts.',
                       'collectorFirstFailure':'collect-r1 failed because it compared reopened persisted run result including clock metadata to the returned result. Original report body was already identical. No product assertion failed; source/log retained. collect-r2 compares report exactly and checks the only added clock explicitly.'},
 'remaining':['LIVE-USD3-R3-01 product repair, affected offline checks and independent review are not part of this read-only report.',
              'Re-freeze any changed product identity and assess whether retained coding PASS evidence remains applicable without relabeling its execution identity.',
              'Any further paid batch needs a concrete reviewed plan and a fresh explicit one-start authorization; this consumed grant gives no restart authority.',
              'A future improve candidate needs exact report/revision and human selection before any candidate action. No candidate exists in this run.'],
 'artifacts':{name:identity(out/name) for name in ['observed-facts.json','read-identities.json','originals-unchanged.json','improve-response-derived.sse','collect.py','collect-r1-source.py','collect-r1.stderr','collect-r2.stdout']},
 'originalResultArtifacts':{name:identity(b/name) for name in ['paid-start.json','batch-result.json','cumulative-budget.json','live-eval-result.json','live-improve-result.json','reopened-improve-report.json']}
}
save('report.json',report)
save('improve-timeline.json',{'failureId':'LIVE-USD3-R3-01','timeline':timeline,'responseDerived':identity(out/'improve-response-derived.sse'),'chunks':facts['improve']['requests'][0]['rawChunkSources']})
md('REPORT.md',f'''# r3 补充批次只读结果报告

本轮状态为 **STOPPED_NO_EXECUTABLE_CHAIN**：三项补充 coding trial 全部 PASS；真实 `improve` 因产品缺陷 **LIVE-USD3-R3-01** 在首个响应后停止，产生 **0 个候选**。未进行候选选择、候选验证、激活或写回。完整机器报告见 `report.json`，诊断见 `IMPROVE-FAILURE.md`。

- 产品：`{facts['product']}`；frozen manifest：`{facts['manifest']['sha256']}`。
- 唯一已记录启动：`2026-10-10T06:38:46.776Z`；结束：`2026-10-10T06:41:35.851Z`；没有追加启动。
- 当前 report：`v1-live-r2-improve` / revision `cc9cbac2720484f05b11666fc06621f9be03fbc40a90ed1d48924397493f19b6`。重新打开的 report 与原 report 完全一致；run result 仅增加持久化 `clock` 元数据。
- cleanup `confirmed`、storage `closed`；`remoteTermination` 仍是 `unknown`，不提升为已证明远端停止。

## Coding 结果与原始失败

| Trial | Host 物理请求 | 已知 tokens | 原始 outcome / grade |
| --- | ---: | ---: | --- |
| r2 `local-fix`（复用） | 7 | 13,370 | completed / PASS |
| r2 `multi-file`（首失败保留） | 8 | 14,129 | error / unknown |
| r3 `v1-live-r2-multi-file` | 8 | 15,574 | completed / PASS |
| r3 `v1-live-r2-regression` | 7 | 15,142 | completed / PASS |
| r3 `v1-live-r2-no-change` | 3 | 3,345 | completed / PASS |

新三项的 scope 与 task 检查均为 true，调用原固定输入与 grader，正式单任务 8 次限制未变。三项 artifact、outcome、grade 与 guest journal 均读取并核对。r2 未运行的 regression/no-change 保留原 `not-run`；r3 新 trial 不覆盖它们。现在四类场景都有 PASS 证据，分属两次执行；不能把原 r2 批次改记成 4/4 PASS，也不能抹去旧 multi-file error / unknown。

## 真实 `improve` 的停止点

首个 host 请求收到 HTTP 200；最后 raw SSE chunk 含 `prompt_tokens=923`、`completion_tokens=29`、`total_tokens=952`、`finish_reason=tool_calls` 与 `[DONE]`。SDK 给出完整 `toolUse` 响应，`evidence_summary` 也正常完成。

产品已保存并解析上述用量，但在 SDK 正常消费 `[DONE]` 后取消 reader 时，把 host settlement 写为 `tokens:null / cancelled / reason:undefined`。第二次 generation 的预算入口于是抛出 `BUDGET_UNKNOWN_USAGE`，记录 `dispatched=false`，没有第二次物理请求。SDK 显示的 `Connection error` 是该本地拒绝的表面错误，不足以判成网络故障。

该缺陷影响 #23 的真实 improve 路径，由 #30 发现。过去独立 offline review/PASS 的候选、时间和适用范围保留；修复、受影响复核和新候选验证完成前，不能宣称这一真实路径通过。

## 预算读回

| 项目 | 数量 |
| --- | ---: |
| 两批累计物理 host 请求 | 34（旧 15 + 新 eval 18 + improve 1） |
| 原 host ledger known tokens | 61,560 |
| 原 host ledger UNKNOWN 预留 tokens | 1,056,768（1 次） |
| 原 host ledger charged upper tokens | 1,118,328 |
| 保守已知估价（1.2 USD / M） | USD 0.073872 |
| 保守已知加未知上界估价 | USD 1.3419936 |
| 诊断中另行观察到的 improve raw usage | 952 tokens |

952 与 SDK 用量一致，可作缺陷证据；**不得回写原 settlement 或把原 UNKNOWN 预留替换成 952**。作为单独的事后 raw 观察，两批共 62,512 tokens，按同一单价估算 USD 0.0750144；它不是原预算账本或账户账单。host 与 SDK/guest 是同一调用的不同观察，不能相加。累计预算没有越界。

19 次新 host 请求都核对了 raw response、HTTP 200、模型返回 alias `deepseek-flash` 与 fingerprint `aeb56401ca74e127821c4f9126dcb669`。这些证明保留响应中的标识，不证明不可变模型权重版本。账户实际账单未观察。

## 原件与工作范围

只使用 SQLite `mode=ro&immutable=1` 读取关闭后的原件，读取前后核对 **7,280** 个输入身份，其中包含 r2 原 **3,167** 个身份；全部不变。improve fixture 的四个文件与 frozen baseline 一致。provider boundary 源码匹配 frozen source-build；安装的 compiled boundary、OpenAI 7.19.0、pi-ai 1.1.0 相关文件匹配 frozen candidate identity。

原件留在 `{b}`。约 635 KB 的详细 facts 与约 2 MB 的完整 read index 留在外部目录，仓库保存本报告、精确路径/哈希、紧凑时间线及诊断脚本。读取记录中的代码和命令仅作为数据，未执行。诊断没有读取凭据，没有 provider 调用、VM 启动、产品执行或重测试。

collector 首次静态断言把 reopened result 的额外 `clock` 当作差异，已保留 `collect-r1-source.py` 和失败日志；第二次仅纠正对持久化元数据的比较，原 report 始终完全一致。此静态提取问题不改变真实产品失败。

后续需要单独修复 LIVE-USD3-R3-01、完成受影响复核并冻结新产品身份，再形成可审阅的下一 paid batch。下一批必须获得新的明确 one-start 授权；本报告不授权自动重跑。后续如有候选，仍须用户选择具体 report/revision/candidate。
''')
md('IMPROVE-FAILURE.md','''# LIVE-USD3-R3-01：终止 SSE 的已知用量在正常取消 reader 时丢失

结论：这是实际冻结产品的 provider boundary 结算缺陷。已有 raw response、host journal、SDK 成功响应与安装源码共同给出因果链；没有为了诊断重放请求或执行产品。

## 精确证据链

同一 host 请求 `5ae550cf-a637-458a-80fa-d518e4ff9aae`，model attempt `f4754a24-9dc0-401f-9c42-3c3ad261a7f6`，improve run `f05d3379-5950-4bfa-aebd-72dd671c4fc3`：

| 序号 | 真实时间（UTC） | 观察 |
| --- | --- | --- |
| 67 / 69 | 见 `improve-timeline.json` | 一次 provider.dispatch / HTTP 200 |
| 88 | 06:41:35.550 | 最后 raw chunk 包含 usage 923 + 29 = 952、tool_calls 与 DONE |
| 89 | 06:41:35.560 | model.provider-event 已保存同一 usage |
| 90 | 06:41:35.570 | budget.settle 写入 tokens null、cancelled、reason undefined |
| 91 | 06:41:35.585 | SDK model.response complete / toolUse / usage 952 |
| 93–95 | 06:41:35.611–.636 | evidence_summary dispatch、summary 和 result 正常完成 |
| 97 | 06:41:35.664 | 下一次 generation.request |
| 100–101 | 06:41:35.699–.710 | fetch intent 后发生 BUDGET_UNKNOWN_USAGE；dispatched=false、attemptDispatched=false |
| 102–103 | 见时间线 | SDK 表面 Connection error；submission model_error / unanswered |
| 110–111 | 见时间线 | improve incomplete / BUDGET_UNKNOWN_USAGE；run failed / TASK_UNANSWERED |

最后 raw chunk SHA256 `a6c66b38e6e0a7fd497a203795724446440c8cababf717e5702c64fc0bc3bbf8`，469 bytes。7 块拼接响应 SHA256 `32104d7dc8f7ef436b2f65544a3ec748e1c4a282f6c7a318dc970a1889421555`，3830 bytes；新派生副本为 `improve-response-derived.sse`。原 chunk 引用、seq、时间与 journal blob 哈希在 `improve-timeline.json`，原 SQLite 与所有 blob 均不改写。

## 与精确安装版本匹配的代码机制

- `src/provider-boundary.ts:54` 从 SSE data 行读取用量；`[DONE]` 无 JSON 可解析，因此被忽略。
- `src/provider-boundary.ts:56` 仅在底层 `reader.read()` 得到 EOF 时执行已知用量结算。
- `src/provider-boundary.ts:61` 先解析取得的 chunk，再向 SDK enqueue；因此真实 seq 88 的用量已取得。
- `src/provider-boundary.ts:63` 的 `cancel(reason)` 无条件结算 `null / cancelled`，没有利用已取得的终止响应状态与用量。
- 安装的 `openai/core/streaming.mjs:97` 在收到 `[DONE]` 后 break；嵌套 iterator 关闭。
- 同文件 `createAbortableSSESource` 在 344–350 行把 source.return 接到 `reader.cancel()`；475–538 行的 SSE 遍历与 finally cleanup 完成这一路径。这是 SDK 按协议结束流的行为，并不需要用户 abort。
- `src/improve.ts:76` 设置 `unknownUpperBound:null`；`src/provider-boundary.ts:30` 遇到未知用量拒绝下一请求，恰好对应 seq 101 的本地拒绝。

源码、compiled boundary 与 SDK 文件的 frozen 绑定和当前 hash 见 `report.json.codeBindings`。当前观察不能把通用 `cancel` 当作始终成功；真实取消、缺失终止标记、非法/缺失用量、消费/传输错误仍需保持保守结算。

## 最小修复建议及必须保留的边界

只调整 provider boundary 对协议终止与 reader 关闭的判定：已取得有效终止 SSE 响应和有效用量时，SDK 正常结束 reader 不应抹掉该已知用量；区分真正的 abort、截断或出错。不得简单将全部 cancel 改成 returned，也不得因看到任意早期 usage 就证明响应完成。

后续实现应验证 DONE 与 usage 同块、跨块及换行边界、终止后 SDK consumer cancel、正常 EOF、真正提前 cancel/abort、缺失/非法 usage、错误/响应限额、单次结算与 unknown 继续阻断。它们是后续实现验证建议，本报告未执行测试。

不得改变正式单任务 8 次请求限制、不得用 raw 952 重写旧 UNKNOWN、不得放松授权、成本或工具边界。旧首失败与原调用输出保持不变。SDK 表面 Connection error 可在后续产品文案中改进，但它不是本次使用量误判的根因，也不应扩大当前最小修复范围。

## 验收与候选状态

此失败记为 **LIVE-USD3-R3-01**，影响 #23 的真实 improve，由 #30 发现。历史 offline PASS 保持其当时范围；新产品修复及受影响复核之前，当前真实路径没有通过。原 report `v1-live-r2-improve` revision `cc9cbac2720484f05b11666fc06621f9be03fbc40a90ed1d48924397493f19b6` 为 incomplete，候选与选择均为 0。未生成可选择包，未运行候选 check 或 writeback。
''')
print(json.dumps({'status':'DERIVATIVE_REPORT_WRITTEN','report':identity(out/'report.json'),'summary':identity(out/'REPORT.md')}))
