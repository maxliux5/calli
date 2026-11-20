export interface CollaborationTarget {
  name: string;
  threadId?: string;
  cwd?: string;
  task?: string;
}

// 旧记录只在原始提示词中保存对象列表，必须从该轮快照恢复，不能套用当前成员名单。
export function historicalCollaborators(prompt: string): CollaborationTarget[] {
  const block = /\n\n\[指定协作对象\]\n([^\n]+)\n请按用户要求安排上述对象/.exec(prompt);
  if (!block) return [];
  try {
    const targets: unknown = JSON.parse(block[1]);
    if (!Array.isArray(targets)) return [];
    return targets.slice(0, 12).flatMap(target => {
      if (!target || typeof target !== 'object') return [];
      const name = typeof target.member === 'string' ? target.member : target.agent;
      if (typeof name !== 'string' || !name.trim()) return [];
      return [{ name,
        ...(typeof target.threadId === 'string' && target.threadId ? { threadId: target.threadId } : {}),
        ...(typeof target.cwd === 'string' && target.cwd ? { cwd: target.cwd } : {}),
        ...(typeof target.task === 'string' && target.task ? { task: target.task } : {}),
      }];
    });
  } catch { return []; }
}
