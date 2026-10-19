import { readObject, digest } from './evidence.js';
import { readRunRecords } from './query.js';
import { currentBuild, currentInstallation } from './artifact.js';
import { executionConfig } from './execution-config.js';
import { readImproveDefaults } from './improve-defaults.js';
import { applyTaskProfile } from './task-profile.js';
import type { ToolEnvironmentConfig } from './coding-environment.js';
import { readFileSync } from 'node:fs';

/**
 * 执行版本（R6、#62 Q1）：构建与依赖内容、Node 与平台、执行配置三项。从已有的 `execution.artifact`
 * 与 `execution.config` 记录推导，不新增记录。任一项不同即“执行版本已变”。
 */
export interface ExecutionVersion {
  /** `execution.artifact` id（自有构建、lock 与直接依赖清单）与安装清单摘要。 */
  build: string; installation: string | null;
  node: string; platform: string; arch: string;
  /** 模型、指令（含 improve 默认项）、设置、mode 与工具环境的摘要。 */
  config: string;
}

const configDigest = (config: any) => digest(JSON.stringify({ model: config.model, instructions: config.instructions, settings: config.settings, mode: config.mode, toolEnvironment: config.toolEnvironment }));

/** run 记录下的执行版本；缺 artifact 或 config 记录时为 null（显示“未记录”，不推断）。只读。 */
export function recordedExecutionVersion(root: string, runId: string): ExecutionVersion | null {
  const records = readRunRecords(root, runId, { limit: 8, kinds: ['execution.artifact', 'execution.config'] }).records;
  const artifactRef = records.find(r => r.kind === 'execution.artifact'), configRef = records.find(r => r.kind === 'execution.config');
  if (!artifactRef || !configRef) return null;
  const artifact = JSON.parse(readObject(root, artifactRef.ref).toString()), config = JSON.parse(readObject(root, configRef.ref).toString());
  return { build: artifact.id, installation: artifact.installation?.sha256 ?? null, node: artifact.node, platform: artifact.platform, arch: artifact.arch, config: configDigest(config) };
}

let build: ReturnType<typeof currentBuild> | undefined, installation: string | undefined;
/** Execution boundaries refresh once before comparing multiple task profiles.
 * UI projections can keep the process cache, but executable bytes must still
 * match the current manifest and the identity must include fresh dependencies. */
export function refreshExecutionVersionArtifacts():void {
  const manifest=JSON.parse(readFileSync(new URL('../execution/source-build.json',import.meta.url),'utf8'));
  for(const file of manifest.outputs){
    const bytes=readFileSync(new URL('../../'+file.path,import.meta.url));
    if(bytes.length!==file.bytes||digest(bytes)!==file.sha256)throw Error(`EXECUTION_BUILD_OUTPUT_DRIFT: ${file.path}`);
  }
  const nextBuild=currentBuild(),nextInstallation=currentInstallation();
  build=nextBuild;installation=nextInstallation;
}
/**
 * 现在开始的普通任务会记录的执行版本。构建部分每个进程算一次；配置部分每次重算（improve 默认值可在
 * 同一进程内改变）。安装清单摘要较重，只在比较到它时才算（`versionChanged` 最后比它）。
 */
export function currentExecutionVersion(options: { dataRoot: string; workspace: string; coding: boolean; mode: 'live' | 'offline'; toolEnvironment?: ToolEnvironmentConfig }): ExecutionVersion {
  build ??= currentBuild();
  let config = executionConfig(options.coding, options.mode, options.toolEnvironment);
  const defaults = readImproveDefaults(options.dataRoot, options.workspace, options.coding ? 'coding' : 'read');
  if (defaults.files.length) config = applyTaskProfile(config, defaults.profile);
  const version = { build: build.id, node: build.node, platform: build.platform, arch: build.arch, config: configDigest(JSON.parse(JSON.stringify(config))) };
  return Object.defineProperty(version, 'installation', { enumerable: true, get: () => installation ??= currentInstallation() }) as ExecutionVersion;
}

/** 两个执行版本是否不同；任一侧未记录时为 null。 */
export function versionChanged(a: ExecutionVersion | null, b: ExecutionVersion | null): boolean | null {
  if (!a || !b) return null;
  if (a.build !== b.build || a.node !== b.node || a.platform !== b.platform || a.arch !== b.arch || a.config !== b.config) return true;
  return a.installation !== null && b.installation !== null && a.installation !== b.installation;
}
