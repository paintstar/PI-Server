export const VALID_THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const VALID_SANDBOX = new Set(['strict', 'dev', 'bypass']);

export const PI_TOOLS_MANIFEST = [
  { name: 'read', label: '文件读取', scope: '工作目录与授权路径', description: '读取文件内容或按字节预览头部，沙箱模式下自动拒绝凭据和敏感路径。' },
  { name: 'write', label: '文件写入', scope: '仅限声明的 ownedPaths', description: '创建或覆盖授权路径内的文件，阻止改写同级代理文件或越界符号链接。' },
  { name: 'edit', label: '精准编辑', scope: '仅限声明的 ownedPaths', description: '按目标文本块局部替换已有文件，适合小步精准修改并生成差异。' },
  { name: 'bash', label: '受限命令执行', scope: '沙箱隔离的工作目录', description: '执行测试、构建和检查命令；联网与路径权限受设置或单代理 allowNetwork、sandboxMode 策略控制。' },
  { name: 'agent_message', label: '汇报与协作消息', scope: '父会话或同组代理', description: '子代理主动向父会话发送进展报告，或向指定的同级代理发送协作指令。' },
  { name: 'ask_parent', label: '阻塞提问与等待', scope: '父会话人工或代理答复', description: '遇到需求歧义或关键决策时暂停等待，通过 reply_question 获取明确答复后继续。' },
];

function formatContextLabel(value, fallback = '标准上下文') {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M 上下文` : `${Math.round(value / 1000)}K 上下文`;
}

const MODEL_FAMILY_RULES = [
  {
    match: (p, m) => (p === 'openai-codex' || p === 'openai') && /^gpt-5\.3-codex-spark/.test(m),
    thinking: 'low',
    description: (m, meta) => `纯文本高速代码编辑模型（${formatContextLabel(meta?.contextWindow)}），不支持图片输入；适合单文件快速改动、测试补全和机械重构。`,
  },
  {
    match: (p, m) => (p === 'openai-codex' || p === 'openai') && /^(o3|o4)/.test(m),
    thinking: 'high',
    description: (m, meta) => `高深度逻辑与算法推理模型（${formatContextLabel(meta?.contextWindow)}），适合复杂根因排查、架构取舍与严谨验证。`,
  },
  {
    match: (p, m) => (p === 'openai-codex' || p === 'openai') && /(mini|nano)/.test(m),
    thinking: 'low',
    description: (m, meta) => `轻量高速低成本 GPT 模型（${formatContextLabel(meta?.contextWindow)}），适合大范围代码检索、摘要整理与高频轻量检查。`,
  },
  {
    match: (p, m) => (p === 'openai-codex' || p === 'openai') && /(pro|codex)/.test(m),
    thinking: 'high',
    description: (m, meta) => `主力多模态编码与审查模型${m.endsWith('-fast') ? '（Fast 优先通道）' : ''}（${formatContextLabel(meta?.contextWindow)}），适合跨文件重构、深度 Code Review 与系统设计。`,
  },
  {
    match: p => p === 'openai-codex' || p === 'openai',
    thinking: 'medium',
    description: (m, meta) => `通用 GPT 多模态编码模型${m.endsWith('-fast') ? '（Fast 通道）' : ''}（${formatContextLabel(meta?.contextWindow)}），支持文本与图片输入，可胜任全栈开发与脚本验证。`,
  },
  {
    match: (p, m) => p === 'anthropic' && /opus/i.test(m),
    thinking: 'high',
    description: (m, meta) => `Claude Opus 高阶推理与架构审查模型（${formatContextLabel(meta?.contextWindow, '200K 上下文')}），适合复杂系统设计、严谨交叉审查与高风险改动把关。`,
  },
  {
    match: (p, m) => p === 'anthropic' && /haiku/i.test(m),
    thinking: 'low',
    description: (m, meta) => `Claude Haiku 高速低成本模型（${formatContextLabel(meta?.contextWindow, '200K 上下文')}），适合快速文件检索、轻量摘要与高频巡查。`,
  },
  {
    match: p => p === 'anthropic',
    thinking: 'medium',
    description: (m, meta) => `Claude Sonnet 均衡编码主力模型（${formatContextLabel(meta?.contextWindow, '200K 上下文')}），擅长多文件工程实现、精准编辑与代码审查。`,
  },
  {
    match: (p, m) => (p === 'google' || p === 'gemini') && /flash/i.test(m),
    thinking: 'low',
    description: (m, meta) => `Gemini Flash 超长上下文高速多模态模型（${formatContextLabel(meta?.contextWindow, '1M 上下文')}），适合大仓库检索、日志摘要与低延迟辅助。`,
  },
  {
    match: p => p === 'google' || p === 'gemini',
    thinking: 'high',
    description: (m, meta) => `Gemini Pro 长上下文深度推理与多模态模型（${formatContextLabel(meta?.contextWindow, '1M 上下文')}），适合全仓库全局分析、架构设计与跨模块排查。`,
  },
  {
    match: (p, m) => (p === 'zhipu' || p === 'zai') && /highspeed/.test(m),
    thinking: 'medium',
    description: (m, meta) => `智谱高速并行编码档位（${formatContextLabel(meta?.contextWindow, '512K 上下文')}），响应速度快，适合中文需求迭代、快速多路验证与页面交互修改。`,
  },
  {
    match: (p, m) => (p === 'zhipu' || p === 'zai') && /(flash|turbo|4\.7)/.test(m),
    thinking: 'low',
    description: (m, meta) => `智谱轻量低成本模型（${formatContextLabel(meta?.contextWindow, '512K 上下文')}），适合快速分类、文档整理、前端小改及并发巡查任务；复杂跨模块设计建议换用 GLM-5.3。`,
  },
  {
    match: p => p === 'zhipu' || p === 'zai',
    thinking: 'high',
    description: (m, meta) => `智谱主力中文编码与工具调用模型，${formatContextLabel(meta?.contextWindow, '512K 上下文')}，适合中文需求理解、前后端业务开发与多轮交互。`,
  },
  {
    match: p => p.startsWith('opencode-go'),
    thinking: 'medium',
    description: (m, meta) => `OpenCode Go 通道模型（${formatContextLabel(meta?.contextWindow, '200K 上下文')}），需保证账号下已有有效 OpenCode Go 订阅后使用。`,
  },
  {
    match: (p, m) => p === 'deepseek' && /pro/.test(m),
    thinking: 'high',
    description: (m, meta) => `DeepSeek ${formatContextLabel(meta?.contextWindow, '1M 上下文')}深度推理模型（纯文本），擅长复杂算法、系统排错与大规模仓库全局分析。`,
  },
  {
    match: p => p === 'deepseek',
    thinking: 'low',
    description: (m, meta) => `DeepSeek ${formatContextLabel(meta?.contextWindow, '1M 上下文')}高速低价模型，适合大仓库日志检索、大批量文件阅读摘要与轻量自动化检查。`,
  },
  {
    match: p => p === 'kimi-coding',
    thinking: 'medium',
    description: (m, meta) => `Kimi 编码专用模型（${formatContextLabel(meta?.contextWindow, '256K 上下文')}${Array.isArray(meta?.input) && meta.input.includes('image') ? '，支持图片' : ''}），长文本理解稳健，适合中文工程阅读与中小型任务实现。`,
  },
  {
    match: p => p === 'minimax-tokenplan',
    thinking: 'low',
    description: (m, meta) => /flash/i.test(m) ? `MiniMax 极速编码预览版，${formatContextLabel(meta?.contextWindow, '512K 上下文')}，延迟低、开销小，适合快速代码改动与界面辅助。` : `MiniMax ${formatContextLabel(meta?.contextWindow, '512K 上下文')}通用多模态编码模型，适合常规脚本编写、文档总结与前端样式微调。`,
  },
  {
    match: p => p === 'aliyun-tokenplan',
    thinking: 'medium',
    description: (m, meta) => /flash/.test(m) ? `通义 Qwen ${formatContextLabel(meta?.contextWindow, '1M 上下文')}轻量极速版，适合长文档检索与低成本批处理。` : `通义 Qwen ${formatContextLabel(meta?.contextWindow, '1M 上下文')}主力模型，综合编码与中文理解能力均衡，适合中大型工程分析。`,
  },
  {
    match: p => p === 'mimo',
    thinking: 'medium',
    description: (m, meta) => /flash/.test(m) ? `MiMo ${formatContextLabel(meta?.contextWindow, '1M 上下文')}极速版，适合低成本长上下文摘要与简单修改。` : `MiMo ${formatContextLabel(meta?.contextWindow, '1M 上下文')}高性价比编码模型，适合常规业务模块开发与并行检查。`,
  },
  {
    match: p => p === 'volc-ark',
    thinking: 'medium',
    description: (m, meta) => /lite/.test(m) ? `豆包 Seed 轻量多模态模型（${formatContextLabel(meta?.contextWindow, '256K 上下文')}），适合快速识别界面截图与简单文本处理。` : `豆包 Seed Pro 多模态模型（${formatContextLabel(meta?.contextWindow, '256K 上下文')}），适合图文结合排查与中文业务开发。`,
  },
  {
    match: p => p === 'step-relay',
    thinking: 'medium',
    description: (m, meta) => `阶跃跃星中继预览模型（${formatContextLabel(meta?.contextWindow, '256K 上下文')}），适合探索性编码任务与方案对照。`,
  },
];

export function filterModelProfiles(models, { provider, search } = {}) {
  const needle = search?.trim().toLowerCase();
  return (models || []).filter(m =>
    (!provider || m.provider === provider) &&
    (!needle || `${m.provider}/${m.model} ${m.name || ''} ${m.description || ''}`.toLowerCase().includes(needle)),
  );
}

export function defaultModelProfile(provider, modelId, meta = {}) {
  for (const rule of MODEL_FAMILY_RULES) {
    if (rule.match(provider, modelId)) {
      return { recommendedThinking: rule.thinking, description: rule.description(modelId, meta) };
    }
  }
  const ctxText = formatContextLabel(meta.contextWindow);
  const modalText = Array.isArray(meta.input) && meta.input.includes('image') ? '支持图文输入' : '纯文本输入';
  const reasonText = meta.reasoning ? '具备显式推理能力，适合分析与编码任务' : '响应直接快速，适合常规轻量问答与脚本';
  return {
    recommendedThinking: meta.reasoning ? 'medium' : 'off',
    description: `${provider} 模型（${ctxText}，${modalText}），${reasonText}。`,
  };
}

export function buildEnrichedModels(rawModels, settings, { includeDisabled = false } = {}) {
  const items = [];
  for (const raw of rawModels || []) {
    const provider = raw.provider;
    const modelId = raw.model || raw.id;
    const key = `${provider}/${modelId}`;
    const providerSetting = Object.hasOwn(settings.providers, provider) ? settings.providers[provider] : undefined;
    const modelSetting = Object.hasOwn(settings.models, key) ? settings.models[key] : {};
    const providerEnabled = providerSetting ? providerSetting.enabled !== false : true;
    const modelEnabled = modelSetting.enabled !== undefined ? modelSetting.enabled !== false : true;
    const enabled = providerEnabled && modelEnabled;
    if (!includeDisabled && !enabled) continue;
    const baseContextWindow = raw.baseContextWindow ?? raw.contextWindow ?? null;
    const baseMaxTokens = raw.baseMaxTokens ?? raw.maxTokens ?? null;
    const contextWindow = Number.isInteger(modelSetting.contextWindow) ? modelSetting.contextWindow : baseContextWindow;
    const maxTokens = Number.isInteger(modelSetting.maxTokens) ? modelSetting.maxTokens : baseMaxTokens;
    const profile = defaultModelProfile(provider, modelId, { ...raw, contextWindow, maxTokens });
    const customDescription = typeof modelSetting.description === 'string' && modelSetting.description.trim() ? modelSetting.description.trim() : null;
    const recommendedThinking = VALID_THINKING.has(modelSetting.recommendedThinking) ? modelSetting.recommendedThinking : profile.recommendedThinking;
    items.push({
      provider,
      model: modelId,
      name: raw.name || modelId,
      reasoning: Boolean(raw.reasoning),
      contextWindow,
      maxTokens,
      baseContextWindow,
      baseMaxTokens,
      input: Array.isArray(raw.input) ? raw.input : ['text'],
      cost: raw.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      enabled,
      providerEnabled,
      modelEnabled,
      description: customDescription || profile.description,
      defaultDescription: profile.description,
      customDescription: Boolean(customDescription),
      recommendedThinking,
      defaultRecommendedThinking: profile.recommendedThinking,
    });
  }
  return items;
}
