import { spawn } from 'node:child_process';
import { EFFORT_LEVELS, type EffortLevel, type ModelOption } from './types.js';

const OUTPUT_LIMIT = 1024 * 1024;

/** Consume only the native catalog envelope; text/session output is never a model list. */
export function doubaoModels(stdout: string): ModelOption[] {
  let record;
  try { record = JSON.parse(stdout); } catch { throw new Error('Doubao 返回了无效模型目录'); }
  if (record?.type === 'result' && record.is_error) throw new Error(Array.isArray(record.errors) ? record.errors.filter((e: unknown) => typeof e === 'string').join('\n') || 'Doubao 模型读取失败' : 'Doubao 模型读取失败');
  if (record?.type !== 'result' || record.subtype !== 'success' || record.result?.type !== 'model_list' || !Array.isArray(record.result.models) || record.result.models.length > 512) {
    throw new Error('Doubao 返回了无效模型目录');
  }
  const seen = new Set<string>();
  return record.result.models.map((model: any): ModelOption => {
    if (typeof model?.id !== 'string' || !model.id.trim() || model.id.length > 256
      || typeof model.name !== 'string' || !model.name.trim() || model.name.length > 512
      || typeof model.is_default !== 'boolean' || !Array.isArray(model.efforts) || seen.has(model.id)) {
      throw new Error('Doubao 返回了无效模型选项');
    }
    seen.add(model.id);
    const efforts: EffortLevel[] = model.efforts.map((effort: any) => {
      const level = effort === 'none' ? 'off' : effort;
      if (!EFFORT_LEVELS.includes(level)) throw new Error('Doubao 返回了未知推理强度，请升级 Calli');
      return level;
    });
    return { id: model.id, label: model.name, isDefault: model.is_default,
      ...(typeof model.description === 'string' ? { description: model.description } : {}),
      efforts: [...new Set(efforts)], images: false };
  });
}

/** 直接调用已安装的原生 CLI，与终端共用服务，不创建或清理服务副本。 */
export async function readDoubaoModels(command: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs = 30_000): Promise<ModelOption[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), 'model', 'list', '--json'], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    let stdout = '', stderr = '', error: Error | undefined, force: NodeJS.Timeout | undefined;
    const stop = (reason: Error) => {
      if (error) return;
      error = reason;
      child.kill('SIGINT');
      force = setTimeout(() => {
        if (process.platform !== 'win32' && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The owned group exited. */ }
        } else child.kill('SIGKILL');
      }, 5000);
      force.unref();
    };
    const timer = setTimeout(() => stop(new Error('Doubao 模型读取超时')), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => {
      if (error) return;
      stdout += text;
      if (Buffer.byteLength(stdout) > OUTPUT_LIMIT) { stdout = ''; stop(new Error('Doubao 模型目录超过大小限制')); }
    });
    child.stderr.on('data', (text: string) => { stderr = (stderr + text).slice(-8192); });
    child.once('error', err => { error = err; });
    // 等查询进程及输出管道结束，始终保留原生安装和共享服务。
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(force);
      if (error) reject(error);
      else if (code !== 0) reject(new Error(stderr.trim() || `Doubao 模型读取失败（code=${code}）`));
      else resolve(stdout);
    });
  });
  return doubaoModels(stdout);
}
