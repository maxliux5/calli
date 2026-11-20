import { execFile } from 'node:child_process';

// 使用原生输出协议，不复制可执行文件或修改脚本资源，避免共享服务身份校验冲突。
export const DOUBAO_STREAM_BRIDGE = { platform: 'Doubao CLI', temporaryMegabytes: 0 };
export interface DoubaoNativeCapabilities { models: boolean; stream: boolean }

/** 只查询帮助，不登录、不创建会话；按公开选项判断能力，兼容旧版默认文本模式。 */
export function readDoubaoNativeCapabilities(command: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<DoubaoNativeCapabilities> {
  return new Promise(resolve => {
    execFile(command[0], [...command.slice(1), '--help'], { cwd, env, timeout: 5000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      resolve({ models: !error && /\bmodel\s+list\b/.test(stdout), stream: !error && /--output-format\b/.test(stdout) && /\bstream-json\b/.test(stdout) });
    });
  });
}
export async function validateDoubaoStreamRuntime(command: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  if (!(await readDoubaoNativeCapabilities(command, env, cwd)).stream) {
    throw new Error('当前 Doubao CLI 不支持原生流式输出，请升级 CLI；当前沿用普通文本输出');
  }
}
