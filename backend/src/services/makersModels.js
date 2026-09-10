/**
 * Makers Models proxy service.
 * Calls Makers Models via the official AI Gateway,
 * OpenAI-compatible chat completions API.
 * Falls back to rule-based plan generation if API is unavailable.
 *
 * Official endpoint: https://ai-gateway.edgeone.link/v1/chat/completions
 *   Authorization: Bearer <MAKERS_MODELS_KEY>
 *
 * Two model categories, same endpoint & auth:
 *   1. Built-in models (@makers/* prefix) — free quota, no vendor key needed.
 *      e.g. @makers/hy3, @makers/deepseek-v4-flash, @makers/kimi-k2.6
 *   2. Vendor models (vendor/name format) — requires binding the vendor's
 *      own API key in the Makers console → Models & Keys page.
 *      e.g. deepseek/deepseek-chat (non-reasoning, fast, recommended),
 *           deepseek/deepseek-v4-flash, deepseek/deepseek-v4-pro (reasoning)
 *
 * Security: API key is never sent to frontend. All calls go through backend.
 */

const MAKERS_MODELS_ENDPOINT = 'https://ai-gateway.edgeone.link/v1/chat/completions';
// Default built-in model (Hunyuan 3.0). Can be overridden via project.makers_model.
// Vendor models (e.g. deepseek/deepseek-v4-pro) use the same endpoint, just a
// different model id — the user must bind the vendor API key in the Makers console.
const DEFAULT_MODEL = '@makers/hy3';

// ---- Context & token budget configuration ---------------------------------
// Centralized, env-overridable limits for the agent's input context window
// and output token ceiling. Larger windows let the model receive longer user
// input / system instructions and emit complete answers instead of being cut
// off mid-JSON. They trade off against the 120s Cloud Function hard timeout
// (reasoning models process input tokens slowly), so the reasoning tier stays
// tighter than the standard tier. Tune without code changes via env vars:
//   MAKERS_CTX_FILE_CHARS(_REASONING)      per-file char cap
//   MAKERS_CTX_MAX_FILES(_REASONING)       max files packed into the prompt
//   MAKERS_MAX_OUTPUT_TOKENS(_REASONING)   output token ceiling
//   MAKERS_INPUT_CHAR_BUDGET(_REASONING)   whole-prompt packing budget
const envInt = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export const CONTEXT_LIMITS = {
  reasoning: {
    maxFileChars: envInt(process.env.MAKERS_CTX_FILE_CHARS_REASONING, 30000),
    maxFiles: envInt(process.env.MAKERS_CTX_MAX_FILES_REASONING, 10),
    headLen: 2000, excerptBefore: 600, excerptAfter: 3200, maxExcerpts: 7, smallFileThreshold: 12000,
  },
  standard: {
    maxFileChars: envInt(process.env.MAKERS_CTX_FILE_CHARS, 90000),
    maxFiles: envInt(process.env.MAKERS_CTX_MAX_FILES, 24),
    headLen: 5000, excerptBefore: 1500, excerptAfter: 6000, maxExcerpts: 14, smallFileThreshold: 48000,
  },
};

// Output token ceiling: reasoning models spend part of the budget on
// reasoning_content before the final JSON, so they get a larger ceiling to
// keep the visible answer complete.
export const OUTPUT_TOKEN_LIMITS = {
  reasoning: envInt(process.env.MAKERS_MAX_OUTPUT_TOKENS_REASONING, 16000),
  standard: envInt(process.env.MAKERS_MAX_OUTPUT_TOKENS, 12000),
};

// Packing budget (chars) for the whole prompt. Model-side context windows are
// far larger (64k–128k tokens); this budget exists to keep generation inside
// the 120s function timeout. Crossing INPUT_WARN_RATIO triggers a recorded
// warning (surfaced in the UI) instead of a silent cut.
export const INPUT_CHAR_BUDGET = {
  reasoning: envInt(process.env.MAKERS_INPUT_CHAR_BUDGET_REASONING, 160000),
  standard: envInt(process.env.MAKERS_INPUT_CHAR_BUDGET, 350000),
};
const INPUT_WARN_RATIO = 0.85;

// Rough token estimate: CJK chars ≈ 1 token each, other chars ≈ 4 per token.
export const estimateTokens = (s) => {
  const str = String(s || '');
  const cjk = (str.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  return Math.round(cjk + (str.length - cjk) / 4);
};

export function isReasoningModelId(model) {
  return /kimi-k2|deepseek-v4|minimax/i.test(model || '');
}

/**
 * Call Makers Models to generate a structured modification plan based on annotations.
 *
 * @param {string} apiKey - Makers Models API key
 * @param {array} annotations - Open annotations with x, y, content, page
 * @param {array} files - Current file list with content
 * @param {string} [model] - Makers built-in model id (default: @makers/hy3)
 * @param {string} [agentsRules] - Optional rules from the prototype root agents.md file.
 *   Injected into the system prompt so the model follows project-specific rules.
 * @returns {Promise<{success: boolean, plan?: object, error?: string, method: string}>}
 */
export async function generatePlanWithMakers(apiKey, annotations, files, model = DEFAULT_MODEL, agentsRules = '', retryFeedback = '', fnStartTime = Date.now()) {
  if (!apiKey) {
    console.log('[makersModels] No API key provided, using rule-based fallback');
    return generateRuleBasedPlan(annotations, files);
  }

  // Dynamic timeout: Cloud Functions have a 120s hard platform limit.
  // By the time we reach here, file I/O + prompt building has already
  // consumed part of the budget. Calculate remaining time and set the
  // fetch deadline so the catch block has time to run the rule-based
  // fallback BEFORE the platform kills the function.
  const CF_HARD_LIMIT_MS = 120000;
  const FALLBACK_BUFFER_MS = 15000; // reserve 15s for fallback generation + JSON response
  const elapsedAtEntry = Date.now() - fnStartTime;
  const remainingBudget = CF_HARD_LIMIT_MS - elapsedAtEntry;
  const minBudgetNeeded = 20000; // need at least 20s to bother calling the API

  if (remainingBudget < minBudgetNeeded) {
    console.warn(`[makersModels] Only ${Math.round(remainingBudget / 1000)}s budget left (elapsed ${Math.round(elapsedAtEntry / 1000)}s), skipping API call → rule-based fallback`);
    const fb = generateRuleBasedPlan(annotations, files);
    fb.fallbackReason = `Insufficient time budget (${Math.round(remainingBudget / 1000)}s left) for API call`;
    fb.method = 'rule-based';
    return fb;
  }

  try {
    // Build the prompt
    const annotationsText = annotations.map((a, i) => {
      const ele = a.element_info || a.elementInfo;
      let elementLine = '';
      if (ele && ele.found) {
        const tag = `<${ele.tagName}${ele.id ? ` id="${ele.id}"` : ''}${ele.className ? ` class="${ele.className}"` : ''}>`;
        const snippet = (ele.text || '').slice(0, 80).replace(/\s+/g, ' ');
        elementLine = `\n    Target element: ${tag}${snippet}</${ele.tagName}> (path: ${ele.path || ''}, isHeading: ${!!ele.isHeading}, fontSize: ${ele.fontSize || 'unknown'})`;
      }
      return `[Annotation ID: ${a.id}] (序号 ${i + 1}) Page: ${a.page || 'index.html'}, Position: (${a.x}%, ${a.y}%), Type: ${a.type || '未标注类型'}, Scope: ${a.scope || `page:${a.page || 'index.html'}`} (page=页面级, modal/drawer=弹窗/抽屉内), Comment: "${a.content}"${elementLine}`;
    }).join('\n');

    // Build file context. Large files (e.g. 260KB generator scripts) cannot be
    // sent whole; slicing the first N chars hides the target page's definition
    // deep in the file and makes the model HALLUCINATE functions that do not
    // exist. Strategy: head of the file + windows around occurrences of the
    // annotated page name(s) and the generator entrypoint (def main).
    //
    // TOKEN BUDGET: EdgeOne Cloud Functions have a 120s hard timeout.
    // Reasoning models (deepseek-v4, kimi-k2, minimax) process input tokens
    // slowly, so we cap context at ~12k chars / 6 files to stay under 100s.
    // Non-reasoning models (deepseek-chat, @makers/hy3) are 3-5x faster, so we
    // give them MUCH more context (30k chars, 10 files, wider excerpts) — this
    // directly improves old_code precision and reduces dry-run match failures.
    const isReasoningModel = isReasoningModelId(model);
    const CTX = isReasoningModel ? CONTEXT_LIMITS.reasoning : CONTEXT_LIMITS.standard;
    const charBudget = isReasoningModel ? INPUT_CHAR_BUDGET.reasoning : INPUT_CHAR_BUDGET.standard;
    const maxTokens = isReasoningModel ? OUTPUT_TOKEN_LIMITS.reasoning : OUTPUT_TOKEN_LIMITS.standard;

    // Context metadata: recorded on the plan so the UI can show how much of
    // the input window was used and warn (instead of silently truncating).
    const contextMeta = {
      model, reasoning: isReasoningModel,
      files_considered: files.length,
      files_included: 0,
      files_omitted: [],
      files_truncated: [],
      prompt_chars: 0,
      est_input_tokens: 0,
      input_char_budget: charBudget,
      max_output_tokens: maxTokens,
      finish_reason: '',
      completion_tokens: null,
      output_truncated: false,
      warnings: [],
    };
    const pageHints = [...new Set(
      annotations
        .map(a => (a.page || '').split('/').pop())
        .filter(p => p && p.length >= 4)
    )];

    // Extract meaningful keywords from annotation content to search across files.
    // These help surface relevant excerpts in sibling files (e.g. shared modal
    // components) even when the file does not contain the target page name.
    const annotationKeywords = [...new Set(
      annotations
        .flatMap(a => {
          const text = String(a.content || '');
          // Chinese terms: sequences of 4+ CJK chars; English/identifiers: words of 4+ chars
          const cjk = text.match(/[\u4e00-\u9fff]{4,}/g) || [];
          const words = (text.match(/[a-zA-Z0-9_-]{4,}/g) || [])
            .filter(w => !/^(https?|www|com|cn|net|org|html|body|div|span|class|id|href|src)$/i.test(w));
          return [...cjk, ...words];
        })
        .filter(Boolean)
    )].slice(0, 12);

    const isGeneratorScript = (path, data) => {
      if (!/\.py$/i.test(path || '')) return false;
      const head = String(data || '').slice(0, 2000).toLowerCase();
      return /(_gen|generate|build|make|render|template|jinja|mako)/i.test(path) || head.includes('def ');
    };

    const buildFileContext = (f) => {
      if (f.content?.binary) return '[binary file]';
      const data = f.content?.data || '';
      // Generator scripts are the source of truth for generated HTML; try to
      // include them whole up to the per-file cap instead of only the head.
      const generator = isGeneratorScript(f.path, data);
      const smallThreshold = generator ? CTX.maxFileChars : CTX.smallFileThreshold;
      if (data.length <= smallThreshold) return data;
      let ctx = data.slice(0, CTX.headLen);
      const hints = [...pageHints, ...annotationKeywords, 'def main'];
      let used = 0;
      for (const hint of hints) {
        let idx = 0;
        while (ctx.length < CTX.maxFileChars) {
          const pos = data.indexOf(hint, idx);
          if (pos === -1) break;
          const start = Math.max(CTX.headLen, pos - CTX.excerptBefore);
          const end = Math.min(data.length, pos + CTX.excerptAfter);
          if (end > start) {
            ctx += `\n\n[... excerpt of ${f.path} around "${hint}" at offset ${pos} ...]\n` + data.slice(start, end);
            used++;
          }
          idx = pos + 1;
          if (used > CTX.maxExcerpts) break;
        }
        if (used > CTX.maxExcerpts) break;
      }
      contextMeta.files_truncated.push(f.path);
      return `(LARGE FILE — showing head + excerpts around the annotated page / entrypoint; offsets are approximate${generator ? '; generator script kept as complete as possible' : ''})\n${ctx}\n[END OF ${f.path} EXCERPTS]`;
    };
    let fileEntries = files.slice(0, CTX.maxFiles).map(f => ({
      path: f.path,
      text: buildFileContext(f),
    }));
    contextMeta.files_included = fileEntries.length;
    contextMeta.files_omitted = files.slice(CTX.maxFiles).map(f => f.path);
    const buildFilesText = () => fileEntries
      .map(e => `--- File: ${e.path} ---\n${e.text}`)
      .join('\n\n');

    // Optional project rules from the prototype's agents.md (injected into the system prompt)
    // NOTE: rules may embed the author's LOCAL machine paths (e.g. "原型设计/phase-2/x.py")
    // which do NOT exist in platform storage — the systemPrompt forbids using them.
    const rulesBlock = agentsRules
      ? `\n## Project Rules (from the prototype's agents.md — follow these for CONTENT decisions; but any file paths mentioned here reflect the author's local machine and are NOT valid in this project — use only the paths from the files list):\n${agentsRules}\n`
      : '';

    const systemPrompt = `You are a prototype review assistant. Based on the reviewer's annotations on a prototype, generate a structured modification plan. For each annotation, suggest specific file changes. Respond in JSON format ONLY (no markdown code fences):
{
  "summary": "Brief summary of the review feedback",
  "changes": [
    {
      "annotation_id": <id>,
      "file_path": "path/to/file.html",
      "description": "What to change",
      "old_code": "exact code snippet to find in the file",
      "new_code": "replacement code"
    }
  ]
}
Rules:
## SMART EDIT methodology（智能修改方法论——最高优先级，用于修正一切"机械字符串替换"倾向）:
你产出的是对原型文件的「精准修改」，不是机械替换。每条 change 的 old_code→new_code 必须按以下 4 步完成：
1. LOCATE（定位问题）: 先审查目标文件中当前不符合预期的代码，判断问题根因（逻辑错误/样式缺失/功能缺失/交互异常），并分析"简单字符串替换"可能引入的错误类型：逻辑冲突、重复代码、遗漏关联项（引用该元素的其他脚本/样式/页面）。
2. REASON（智能修改）: 基于文件整体上下文做结构性和逻辑性修改——调整函数体、属性值、事件绑定、样式规则本身，让 new_code 与整体设计一致；禁止「在 old_code 前后加一行注释/TODO」式的敷衍改动；若纯文本替换无法解决问题，new_code 必须包含问题所在的结构（如触发该行为的 class、事件绑定、样式声明）。
3. AVOID（错误规避）: 产出前自查三类关联错误——① 变量/函数/ID 引用一致性：改动标识符时必须同步所有引用点；② 样式或组件命名冲突：不引入与现有选择器冲突的 class/id，优先复用已有样式；③ 依赖关系断裂：删除或修改元素前确认没有 JS 事件、CSS 选择器或跨页面链接引用它，防止破坏原型其他功能。
4. VERIFY（验证结果）: 产出前自查——old_code 从文件摘录逐字符复制且在目标文件中唯一匹配；new_code 完整自洽（标签闭合/括号配对/引号成对）；每条 change 的 description 末尾用「关键点：…；注意：…」写明修改核心与需要人工复核的风险点。
- CONTEXT SCOPE rule: 严格限制上下文范围，仅包含本次实际需要修改的文件，剔除所有无关的上下文信息。例如，如果本次修改仅涉及商家控制台页面，则只需关注与该商家控制台页面相关的文件、代码段和配置，避免被其他模块、页面或系统的无关内容分散注意力。请确保修改建议精简、聚焦，快速定位到目标文件并进行精准修改，同时保持修改过程的清晰性和高效性。如果提供的文件列表中包含与批注无关的文件，直接忽略它们，不要把无关文件的内容纳入 reasoning。
- file_path must be copied VERBATIM from the "--- File: <path>" headers of the project files list in the user message. Keep the exact subdirectory prefix as shown there.
- Paths that appear inside agents.md / project rules may come from ANOTHER machine's local folder layout (e.g. "原型设计/phase-2/..." while storage has "phase-2/..."). NEVER use paths from the rules text as file_path — always use the storage-relative path from the files list.
- old_code must be a substring that actually exists in the current file, so it can be replaced.
- NEVER invent or reconstruct code that is not shown in the provided file excerpts. If the section you need is not visible in the excerpts, still build old_code ONLY from lines that appear verbatim in the excerpts (e.g. the file's real function/definition structure). Copy old_code character-for-character from the excerpt text.
- Every annotation should map to one change.
- annotation_id must be the REAL "Annotation ID" shown in brackets at the start of each annotation line (e.g. [Annotation ID: 986]), NOT the 序号/index and NOT a number you invent. Copy it verbatim. A dual-write pair (generator .py + HTML output) shares the SAME annotation_id.
- CRITICAL precision rule: if an annotation includes "Target element" info, you MUST modify ONLY that exact element. Use the element's tag name, id, class, and path to build a unique old_code snippet. The old_code must include the target element's opening tag (with id/class attributes) and enough parent context so it matches EXACTLY ONCE in the file. Do NOT perform plain text replacements that could hit other parts of the page.
- If no element info is provided, infer the target from the coordinate position (y≈top means header/hero, y≈bottom means footer) and still include the surrounding HTML context in old_code.
- NEVER use a bare text snippet (e.g. just the text being changed) as old_code. The old_code must always contain the HTML tag and enough surrounding context.
- GENERATOR-SCRIPT precision rule (applies when the target file is a Python generator script: _gen*.py, generate*.py, build.py, make*.py, or any .py whose content embeds HTML templates):
  1. The old_code MUST include a unique function anchor — e.g. the function definition line "def <name>(): " plus the first 1-3 lines of that function's body, or code that exists only inside the intended function. NEVER let old_code be an HTML snippet that appears in more than one page template inside the script (e.g. a shared badge/header block rendered by both the entry index and a sub-page template) — if it does, extend old_code upward/downward until it matches EXACTLY ONCE.
  2. Target the function that is actually invoked to produce the page: check how the script's main() / entrypoint writes output files and edit the function whose output reaches that file (e.g. render_index() for the root index.html). Do NOT edit a dead/duplicate function that is defined but never called — the change would silently have no effect on the deployed page.
  3. When the change is to a generator script, the description MUST note that generated HTML outputs (if any) need regeneration after the change, e.g. via the project's regeneration flow.
  4. GENERATOR DUAL-WRITE rule: when the target is a generator script, you MUST produce PAIRED changes for every affected page:
     a) One change edits the generator script (.py) — old_code MUST include a unique function anchor per rule 1 above; this keeps the source of truth consistent.
     b) One change edits the corresponding HTML output file directly — old_code and new_code MUST be copied verbatim from the HTML file's current content (NOT reconstructed from the .py template). This is the artifact that gets deployed.
     Both changes must reference each other in their description (e.g. "同步修改生成器 _gen_pages.py 的 render_m_agency() 函数" / "HTML 产物，对应生成器脚本的同步修改"). This lets the platform detect the dual-write pair and deploy the HTML directly WITHOUT needing external Python regeneration.
- When the annotation is about opening prototype sub-pages in the current page/tab instead of a new tab, fix BOTH forms of same-origin navigation:
  1. <a href="relative.html" target="_blank"> → change target to "_self" (or remove the target attribute).
  2. onclick handlers or scripts calling window.open('relative.html', '_blank') → change to window.location.href = 'relative.html'.
- Do NOT change external absolute links (http:// or https://) unless the annotation explicitly asks for it.
${rulesBlock}`
    // Dry-run precheck feedback: when a previous attempt's changes failed the
    // automated match validation (file missing / old_code not found / ambiguous),
    // the caller regenerates with the concrete errors appended here so the model
    // can fix its own mistakes instead of surfacing them at apply time.
    const feedbackBlock = retryFeedback
      ? `\n\n## VALIDATION ERRORS FROM YOUR PREVIOUS ATTEMPT
Your previously generated changes FAILED automated prechecks. Fix EVERY error below and output the FULL corrected plan, following the SMART EDIT methodology above (LOCATE → REASON → AVOID → VERIFY): re-read the provided file excerpts, copy old_code character-for-character from the real file content, ensure it matches EXACTLY ONCE, keep new_code structurally consistent with the surrounding design, and use only file paths from the "--- File: <path>" headers.
${retryFeedback}`
      : '';

    const buildUserPrompt = (filesText) => `## Annotations:
${annotationsText}

## Current Files:
${filesText}${feedbackBlock}

Generate a modification plan in JSON format.`;

    // ---- Input budget guard -------------------------------------------------
    // Measure the assembled prompt. If it exceeds the packing budget, drop the
    // LEAST relevant files until it fits, recording exactly what was omitted.
    // Crossing INPUT_WARN_RATIO records a warning instead of silently degrading
    // context quality. Protected classes (target pages, generator scripts,
    // sibling files in the same directory) are dropped last.
    const targetDirs = new Set(pageHints.map(p => p.split('/').slice(0, -1).join('/') || '.'));
    const fileImportance = (entry) => {
      const p = entry.path;
      const base = p.split('/').pop() || '';
      const dir = p.split('/').slice(0, -1).join('/') || '.';
      if (pageHints.includes(base)) return 1000;
      if (isGeneratorScript(p, entry.text)) return 800;
      if (targetDirs.has(dir)) return 500;
      if (/\.py$/i.test(p)) return 400;
      return 0;
    };
    let userPrompt = buildUserPrompt(buildFilesText());
    while (fileEntries.length > 1 && (systemPrompt.length + userPrompt.length) > charBudget) {
      // Sort by importance ascending and drop the least important entry while
      // preserving the original order of the survivors for the final message.
      const sorted = [...fileEntries].map((e, i) => ({ e, i, imp: fileImportance(e) })).sort((a, b) => a.imp - b.imp);
      const dropIdx = sorted[0].i;
      const [dropped] = fileEntries.splice(dropIdx, 1);
      contextMeta.files_included = fileEntries.length;
      contextMeta.files_omitted.push(`${dropped.path}（超出输入预算被省略）`);
      userPrompt = buildUserPrompt(buildFilesText());
    }
    contextMeta.prompt_chars = systemPrompt.length + userPrompt.length;
    contextMeta.est_input_tokens = estimateTokens(systemPrompt + userPrompt);
    console.log(`[makersModels] Prompt size: ${contextMeta.prompt_chars} chars (~${contextMeta.est_input_tokens} tokens), budget ${charBudget}, files ${contextMeta.files_included}/${contextMeta.files_considered}`);
    if (contextMeta.prompt_chars > charBudget * INPUT_WARN_RATIO) {
      const omittedNote = contextMeta.files_omitted.length
        ? `已省略文件：${contextMeta.files_omitted.join('、')}。`
        : '';
      contextMeta.warnings.push(`输入上下文接近上限：当前约 ${contextMeta.est_input_tokens} tokens（${contextMeta.prompt_chars} 字符 / 预算 ${charBudget}）。${omittedNote}建议减少批注数量或分批生成，避免模型遗漏细节。`);
    }
    if (contextMeta.files_truncated.length > 0) {
      contextMeta.warnings.push(`${contextMeta.files_truncated.length} 个大文件仅包含头部+关键摘录（非全文）：${contextMeta.files_truncated.join('、')}。涉及这些文件的修改建议请重点核对 old_code 精确性。`);
    }

    console.log(`[makersModels] Calling Makers Models API (model=${model}, reasoning=${isReasoningModel})...`);

    // isReasoningModel was determined above (before file context building) so
    // we could use model-dependent context limits. Same variable reused here.
    // Output ceiling comes from OUTPUT_TOKEN_LIMITS (env-overridable) — the
    // raised ceilings keep long answers complete instead of being cut off
    // mid-JSON (reasoning models spend part of the budget on reasoning_content).
    const payload = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: maxTokens,
      response_format: { type: 'json_object' }
    };
    if (!isReasoningModel) {
      payload.temperature = 0.3;
    }

    // Dynamic fetch timeout based on remaining Cloud Function budget.
    // We need: fetchTime + fallbackBuffer < remainingBudget
    const elapsedBeforeFetch = Date.now() - fnStartTime;
    const remainingForFetch = CF_HARD_LIMIT_MS - elapsedBeforeFetch - FALLBACK_BUFFER_MS;
    const fetchTimeoutMs = isReasoningModel
      ? Math.min(105000, Math.max(15000, remainingForFetch))
      : Math.min(50000, Math.max(15000, remainingForFetch));

    console.log(`[makersModels] Fetch timeout: ${Math.round(fetchTimeoutMs / 1000)}s (elapsed ${Math.round(elapsedBeforeFetch / 1000)}s, model=${model})`);

    let response;
    try {
      response = await fetch(MAKERS_MODELS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(fetchTimeoutMs)
      });
    } catch (fetchErr) {
      const isTimeout = fetchErr.name === 'TimeoutError' || fetchErr.name === 'AbortError';
      if (isTimeout) {
        throw new Error(
          `模型响应超时（${Math.round(fetchTimeoutMs / 1000)}s，已用 ${Math.round(elapsedBeforeFetch / 1000)}s）。` +
          `推理模型生成方案需要较长时间。建议：① 减少批注数量后分批生成；② 换用更快的模型（如 @makers/hy3）。`
        );
      }
      throw fetchErr;
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Makers Models API returned ${response.status}: ${errText.slice(0, 300)}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const finishReason = data.choices?.[0]?.finish_reason || '';
    const reasoningContent = data.choices?.[0]?.message?.reasoning_content || '';
    const usage = data.usage;
    contextMeta.finish_reason = finishReason;
    contextMeta.completion_tokens = usage?.completion_tokens ?? null;

    // Empty content → reasoning likely consumed the entire max_tokens budget.
    // Throw so the catch block generates a rule-based fallback.
    if (!content || content.trim().length === 0) {
      console.warn(`[makersModels] Empty content from model. finish_reason=${finishReason}, reasoning length=${reasoningContent.length}, usage=${JSON.stringify(usage)}`);
      throw new Error(`模型返回空内容（finish_reason=${finishReason}）。推理模型可能因 reasoning 耗尽 token 预算导致 JSON 输出被截断。建议换用非推理模型（@makers/hy3）或减少批注数量。`);
    }

    // Try to parse JSON from the response
    let planData;
    try {
      // Strip reasoning/thinking tags that some models (e.g. minimax-m3) inline
      // into `content` (e.g. "<think>...</think>\n{...}"). This is a safety net —
      // kimi/deepseek put reasoning into a separate `reasoning_content` field.
      let clean = content
        .replace(/<think[\s\S]*?<\/think>/gi, '')
        .replace(/<reasoning[\s\S]*?<\/reasoning>/gi, '')
        .replace(/```(?:json)?\s*/gi, '')
        .replace(/```/g, '');
      // Extract JSON from possible markdown code blocks
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      planData = JSON.parse(jsonMatch ? jsonMatch[0] : clean);
    } catch (parseErr) {
      // Truncation-aware recovery: when the model hit the output token limit
      // mid-JSON (finish_reason === 'length'), salvage the COMPLETE change
      // objects emitted before the cut instead of discarding the whole
      // response. The salvaged plan is flagged output_truncated so the UI
      // warns the reviewer instead of presenting it as a full answer.
      const salvaged = finishReason === 'length' ? repairTruncatedPlanJson(content) : null;
      if (salvaged && Array.isArray(salvaged.changes) && salvaged.changes.length > 0) {
        planData = salvaged;
        contextMeta.output_truncated = true;
        contextMeta.warnings.push(
          `模型输出在 ${usage?.completion_tokens ?? '?'} tokens 处被截断（已达输出上限 ${maxTokens}）。` +
          `已抢救出截断前完整的 ${salvaged.changes.length} 条修改建议，但方案可能不完整——建议核对后对剩余批注分批重新生成。`
        );
        console.warn(`[makersModels] Output truncated at ${usage?.completion_tokens}/${maxTokens} tokens; salvaged ${salvaged.changes.length} complete change(s)`);
      } else {
        // DO NOT swallow as empty plan — throw so catch block generates
        // rule-based fallback with a useful reason.
        console.warn(`[makersModels] Failed to parse JSON (finish_reason=${finishReason}). Content preview: ${content.slice(0, 300)}`);
        throw new Error(`模型返回内容无法解析为 JSON（finish_reason=${finishReason}，内容前 300 字符: ${content.slice(0, 300)}）。`);
      }
    }

    // Near-limit warning: output completed but consumed most of the token
    // ceiling — the NEXT, slightly larger request would truncate.
    if (!contextMeta.output_truncated && usage?.completion_tokens
        && usage.completion_tokens >= 0.85 * maxTokens) {
      contextMeta.warnings.push(
        `模型输出已使用 ${usage.completion_tokens}/${maxTokens} tokens（接近输出上限）。本次结果完整，但更复杂的任务建议分批生成以避免截断。`
      );
    }

    // Normalize changes
    const changes = Array.isArray(planData.changes) ? planData.changes : [];
    if (changes.length === 0 && annotations.length > 0) {
      // Model returned valid JSON but zero changes despite having annotations.
      // Throw so the catch block falls back to rule-based generation.
      console.warn(`[makersModels] Model returned 0 changes for ${annotations.length} annotation(s). summary=${planData.summary || '(none)'}`);
      throw new Error(`模型返回的修改建议为空（0 条 changes），但存在 ${annotations.length} 条待处理批注。可能原因：max_tokens 不足导致输出被截断，或模型未能理解批注内容。`);
    }

    return {
      success: true,
      plan: {
        summary: planData.summary || `Generated from ${annotations.length} annotation(s).`,
        changes
      },
      model,
      usage,
      method: 'makers',
      contextMeta
    };
  } catch (err) {
    console.warn(`[makersModels] API call failed: ${err.message}. Using rule-based fallback.`);
    const fallback = generateRuleBasedPlan(annotations, files);
    fallback.fallbackReason = `Makers Models API call failed: ${err.message}`;
    fallback.method = 'rule-based';
    return fallback;
  }
}

/**
 * Salvage complete top-level change objects from a TRUNCATED JSON plan
 * (finish_reason === 'length'). The model ran out of output tokens mid-JSON;
 * instead of discarding the whole response we close the JSON at the last
 * complete object boundary and keep whatever was fully emitted.
 * Strategy: walk backwards over candidate "}," boundaries and try to close the
 * JSON with "]}"; the first candidate that parses to an object with a changes
 * array wins. Boundaries that fall inside string literals simply fail to parse
 * and are skipped.
 * @returns {{summary?: string, changes: array}|null}
 */
export function repairTruncatedPlanJson(raw) {
  const clean = String(raw || '')
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning[\s\S]*?<\/reasoning>/gi, '')
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '');
  let pos = clean.lastIndexOf('},');
  let attempts = 0;
  while (pos !== -1 && attempts < 30) {
    attempts++;
    try {
      const parsed = JSON.parse(clean.slice(0, pos + 1) + ']}');
      if (Array.isArray(parsed.changes)) return parsed;
    } catch { /* boundary inside a string / mid-value — try an earlier one */ }
    pos = clean.lastIndexOf('},', pos - 1);
  }
  return null;
}

/**
 * Rule-based fallback plan generator.
 * Creates simple modification suggestions based on annotation content.
 * Exported so callers (e.g. plans.js) can invoke it directly as a last-resort
 * fallback when the Makers API path fails entirely (e.g. Cloud Function killed
 * by platform timeout before the in-function catch can run).
 */
export function generateRuleBasedPlan(annotations, files) {
  const changes = annotations.map(ann => {
    // Try to guess the file from the page or default to index.html
    const filePath = ann.page || 'index.html';
    const fileRecord = files.find(f => f.path === filePath);

    let oldCode = '';
    let newCode = '';
    let description = ann.content;

    if (fileRecord && !fileRecord.content?.binary) {
      const content = fileRecord.content.data;
      const ele = ann.element_info || ann.elementInfo;
      if (ele && ele.text) {
        // Try to locate the probed element text in the file
        const idx = content.indexOf(ele.text.slice(0, 120));
        if (idx !== -1) {
          const start = Math.max(0, idx - 200);
          const end = Math.min(content.length, idx + Math.min(ele.text.length, 120) + 200);
          oldCode = content.slice(start, end);
          newCode = `<!-- TODO: Address annotation "${ann.content}" on element <${ele.tagName}> -->.\n${oldCode}`;
        }
      }
      if (!oldCode) {
        // Fallback: find a relevant snippet by line position
        const lines = content.split('\n');
        const targetLine = Math.floor((ann.y / 100) * lines.length);
        const startLine = Math.max(0, targetLine - 2);
        const endLine = Math.min(lines.length, targetLine + 3);
        oldCode = lines.slice(startLine, endLine).join('\n');
        newCode = `<!-- TODO: Address annotation: ${ann.content} -->\n${oldCode}`;
      }
    }

    return {
      annotation_id: ann.id,
      file_path: filePath,
      description: `Based on annotation "${ann.content}": Modify ${filePath} to address the reviewer's feedback.`,
      old_code: oldCode || '(auto-generated, may need manual adjustment)',
      new_code: newCode || `<!-- TODO: Address: ${ann.content} -->`,
      status: 'pending'
    };
  });

  return {
    success: true,
    plan: {
      summary: `Generated ${changes.length} modification suggestion(s) based on ${annotations.length} annotation(s). (Rule-based fallback - Makers Models API not available)`,
      changes
    },
    method: 'rule-based'
  };
}
