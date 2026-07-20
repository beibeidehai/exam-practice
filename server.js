const http = require('http');
const fs = require('fs');
const path = require('path');
const tencentcloud = require('tencentcloud-sdk-nodejs-tts');
const TtsClient = tencentcloud.tts.v20190823.Client;

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const TENCENT_SECRET_ID = process.env.TENCENT_SECRET_ID;
const TENCENT_SECRET_KEY = process.env.TENCENT_SECRET_KEY;
const PORT = process.env.PORT || 3456;
const sessions = {};

const FILLER_WORDS = ['嗯', '啊', '呃', '额', '那个', '然后', '就是', '就是说', '这个', '怎么说呢', '其实', '反正', '对吧', '你懂吧'];
const MAX_ANSWER_LEN = 600; // chars — warn if answer exceeds this

function getType(file) {
  const map = { '.html': 'text/html;charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
  return map[path.extname(file)] || 'text/plain';
}

function buildSystemPrompt(role, difficulty) {
  if (role === '考研复试-英语口语') {
    return `You are a friendly yet professional English oral examiner for a Chinese postgraduate entrance interview. Difficulty: ${difficulty}.

Core topics to cover (pick 3-4 based on conversation flow):
- Self-introduction: academic background, hometown, university
- Research interests & motivation for choosing this major/university
- An academic project or paper you participated in — what was your role, what did you learn
- A specific challenge or failure during undergrad & how you handled it
- Future study plan & career goals (5-year vision)
- Views on a recent development or trend in your field
- Hobbies, teamwork experience, leadership example
- Why grad school instead of industry? Strengths & weaknesses?

Style:
- Start with a warm greeting, then ask the first question naturally.
- Each turn, listen and ask a relevant follow-up — dig deeper based on what they said.
- If an answer is too short or vague, gently push: "Could you elaborate?" or "Give a specific example."
- Be encouraging, nod verbally ("That's interesting", "I see") before following up.
- Mix behavioral questions with opinion questions.
- After 5-6 exchanges, wrap up with "面试结束" and a brief encouraging remark.

Start now.`;
  }
  if (role === '考研复试-专业综合') {
    return `你是一位经验丰富的考研复试导师，正在进行专业综合面试。难度：${difficulty}。

核心考察范围（根据对话自然穿插，每次只问一个问题）：
- 专业基础：核心课程的核心概念、基本理论、经典实验/算法
- 学科前沿：近3年该领域的重要进展、热点方向、代表性论文或技术突破
- 科研思维：如何设计一个研究方案、如何分析实验结果、如何排除干扰因素
- 项目深挖：毕设/竞赛/论文中的技术选型理由、遇到的最大困难、创新点在哪
- 综合素养：为什么选这个方向、读过哪些经典著作/论文、对学术道德的看法
- 开放性思辨：某个学科争议话题你怎么看、如果重做毕设你会怎么改进

面试风格：
- 不是在念题，而是在聊天。根据ta的回答自然地追问。
- 回答好先肯定再深挖，回答浮于表面温和追问细节，偏题就礼貌拉回。
- 考查：基础扎实度、学术视野广度、独立思考能力、表达逻辑。
- 5-6轮后自然收尾，说"面试结束"，给一句鼓励。

现在开始：先打个招呼，让候选人简单介绍自己，然后进入第一个专业问题。`;
  }
  if (role === '考研复试-综合面试') {
    return `你是一位考研复试的综合面试导师，难度：${difficulty}。

核心考察主题（每次只问一个，根据回答自然延伸）：
- 自我介绍与动机：为什么考研而不是工作、为什么选这个学校这个专业
- 本科经历深挖：最有收获的一门课、最骄傲的一个项目、最遗憾的一件事
- 科研潜力：参与过的课题或竞赛中你具体做了什么、遇到困难怎么解决的
- 抗压与成长：经历过最大的挫折、被批评的一次经历、如何平衡多件事
- 团队协作：描述一次团队合作中有分歧的情况、你在团队中通常扮演什么角色
- 职业与人生规划：研究生阶段计划、毕业后想做什么、十年后想成为什么样的人
- 价值观与思辨：你怎么看待学术诚信、如何看待"内卷"、好研究的标准是什么
- 压力测试：如果导师让你做一个不感兴趣的方向怎么办、如果复试失败有什么打算

面试风格：
- 氛围轻松但不随意，像聊天不是审讯。
- 空泛回答要具体例子，有意思的回答先认可再深挖。
- 适当抛压力问题看应对，但不要刻意刁难。
- 5-6轮后自然收尾，说"面试结束"，给一句鼓励。

现在开始：先简单寒暄，让学生自我介绍，然后自然地展开提问。`;
  }

  return `你是一位资深${role}面试官，正在进行一场专业面试。难度：${difficulty}。

岗位核心考察点：
- 产品经理：需求分析、用户调研、PRD撰写、数据分析、跨部门协作、优先级排序、A/B实验设计、产品sense。常问：你最喜欢的产品是什么为什么、设计一个XX功能、如何衡量XX指标、如何处理需求冲突。
- Java后端开发工程师：JVM内存模型与GC、并发编程（锁/synchronized/AQS/线程池）、Spring/Spring Boot原理、MySQL索引与优化、Redis数据结构与应用场景、分布式系统（CAP/一致性/消息队列）、系统设计（秒杀/短链/IM）、设计模式。每轮深挖一个技术点，要求举例或画思路。
- 前端开发工程师：HTML/CSS/JS基础、React/Vue原理（虚拟DOM/响应式/调度）、浏览器渲染与性能优化、网络（HTTP/缓存/跨域）、工程化（Webpack/Vite/CI/CD）、安全（XSS/CSRF）、系统设计题（设计一个组件库/搭建平台）。每轮深挖一个技术方向。
- 数据分析师：SQL复杂查询与窗口函数、指标体系搭建、A/B实验设计与置信度、归因分析、用户画像与分群、数据可视化与报告呈现、业务sense（如何定义DAU下降的原因、如何评估一个功能的收益）。结合实际业务场景提问。
- 算法工程师：机器学习经典算法推导、深度学习模型结构设计、特征工程、模型评估与过拟合处理、推荐/搜索/NLP/CV方向的具体问题、工程落地（模型部署/性能优化）、最新论文思路讨论。每题可追问数学细节或工程trade-off。

面试风格：
- 先简单寒暄让候选人放松，然后自然进入第一个问题。
- 每次只问一个问题，根据回答决定追问方向：答得好深挖细节，答得模糊要求举例，答偏了温和拉回。
- 出彩的回答简短认可后继续深入，知识盲区不嘲讽、换个角度给机会。
- 5-6轮后自然收尾，说"面试结束"。

现在开始。`;
}

function buildEvalPrompt(role, history, fluencyData) {
  const dims = role.startsWith('考研复试')
    ? `1. 专业知识（1-10）
2. 逻辑表达（1-10）
3. 语言流畅度（1-10）：参考指标 — 填充词比例${fluencyData.fillerRatio}%，语速${fluencyData.wpm}字/分钟，最长停顿${fluencyData.maxPause}秒
4. 临场应变（1-10）
5. 沟通技巧（1-10）`
    : `1. 专业能力（1-10）
2. 逻辑表达（1-10）
3. 语言流畅度（1-10）：参考指标 — 填充词比例${fluencyData.fillerRatio}%，语速${fluencyData.wpm}字/分钟
4. 临场应变（1-10）
5. 沟通技巧（1-10）`;

  return `你是一个${role}面试评估专家。以下是完整面试记录和语言数据分析，请给出评价。

面试记录：
${history}

语言数据（来自语音识别）：
- 总字数：${fluencyData.totalChars}
- 填充词比例：${fluencyData.fillerRatio}%
- 语速：${fluencyData.wpm} 字/分钟
- 最长停顿：${fluencyData.maxPause} 秒
- 填充词列表：${fluencyData.fillerList.join('、') || '无'}

请从以下维度打分（1-10分），并给出评语和改进建议：
${dims}

最后给出总分（满分50）和一句话总结。严格返回JSON：
{"专业知识":8,"逻辑表达":7,"语言流畅度":6,"临场应变":7,"沟通技巧":8,"总分":36,"总结":"...","建议":["改进点1","改进点2"]}`;
}

function calcFluency(answers) {
  const allText = answers.join(' ');
  const totalChars = allText.length;
  if (totalChars === 0) return { totalChars: 0, fillerRatio: 0, wpm: 0, maxPause: 0, fillerList: [] };

  // Count filler words
  const found = {};
  FILLER_WORDS.forEach(w => {
    const re = new RegExp(w, 'g');
    const matches = allText.match(re);
    if (matches) found[w] = matches.length;
  });
  const fillerCount = Object.values(found).reduce((a, b) => a + b, 0);
  const fillerList = Object.entries(found).map(([w, c]) => `${w}(${c}次)`);

  // Crude word count (Chinese chars + English words)
  const chineseChars = (allText.match(/[一-鿿]/g) || []).length;
  const englishWords = (allText.match(/[a-zA-Z]+/g) || []).length;
  const totalWords = chineseChars + englishWords;
  const fillerRatio = totalWords > 0 ? Math.round(fillerCount / totalWords * 1000) / 10 : 0;

  // Estimate WPM (assume average recording time, rough)
  const estimatedMinutes = Math.max(1, totalChars / 300); // ~300 chars/min average speech
  const wpm = Math.round(totalWords / estimatedMinutes);

  return { totalChars, fillerRatio, wpm, maxPause: 0, fillerList, totalWords };
}

// ── Server ──

const server = http.createServer(async (req, res) => {
  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // API: start interview
  if (req.url === '/api/start' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { role, difficulty } = JSON.parse(body);
        const sid = Date.now().toString(36);
        const msg = { role: 'system', content: buildSystemPrompt(role, difficulty) };
        sessions[sid] = { role, difficulty, history: [msg], questionCount: 0, answers: [], fluencySnapshots: [] };

        const result = await callDeepSeek(sessions[sid].history);
        const reply = result.choices[0].message.content;
        sessions[sid].history.push({ role: 'assistant', content: reply });
        sessions[sid].questionCount = 1;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sid, reply }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: answer & continue
  if (req.url === '/api/answer' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { sid, answer } = JSON.parse(body);
        const s = sessions[sid];
        if (!s) throw new Error('Session expired, please restart');

        s.history.push({ role: 'user', content: answer });
        s.answers.push(answer);
        s.questionCount++;

        if (s.questionCount >= 10 || answer.includes('结束面试')) {
          const fluency = calcFluency(s.answers);
          const historyText = s.history.map(m => `[${m.role}]: ${m.content}`).join('\n');
          const evalPrompt = buildEvalPrompt(s.role, historyText, fluency);
          const evalResult = await callDeepSeek([{ role: 'user', content: evalPrompt }]);
          const raw = evalResult.choices[0].message.content;
          const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
          const evaluation = JSON.parse(cleaned);
          evaluation._fluency = fluency;
          delete sessions[sid];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ done: true, evaluation }));
          return;
        }

        const result = await callDeepSeek(s.history);
        const reply = result.choices[0].message.content;
        s.history.push({ role: 'assistant', content: reply });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ done: false, reply }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: interrupt check — AI judges if current speech should be interrupted
  if (req.url === '/api/interrupt' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { sid, text } = JSON.parse(body);
        const s = sessions[sid];
        if (!s) return res.end(JSON.stringify({ interrupt: false }));

        // Quick local checks first
        if (text.length > MAX_ANSWER_LEN) {
          return res.end(JSON.stringify({ interrupt: true, reason: '回答超长，请精简', msg: '抱歉打断一下，你的回答有些长了，能否用一句话总结核心观点？' }));
        }

        // Count filler words in this chunk
        let fillerCount = 0;
        FILLER_WORDS.forEach(w => {
          const re = new RegExp(w, 'g');
          const matches = text.match(re);
          if (matches) fillerCount += matches.length;
        });
        if (text.length > 100 && fillerCount / text.length > 0.08) {
          return res.end(JSON.stringify({ interrupt: true, reason: '填充词过多', msg: '我打断一下，注意到你用了比较多的语气词，试着放慢语速，想清楚再说。' }));
        }

        // Ask DeepSeek if off-topic (only if text is substantial)
        if (text.length > 80) {
          const prompt = `你是面试官。候选人正在回答面试问题。当前转写文本如下。"${text}"。请判断候选人是否明显偏题或逻辑混乱。如果是，回复"打断"并给出追问；如果不是，回复"继续"。只回复两个字："打断"或"继续"。`;
          const result = await callDeepSeek([{ role: 'user', content: prompt }]);
          const reply = result.choices[0].message.content.trim();
          if (reply.includes('打断')) {
            const followup = await callDeepSeek([
              { role: 'user', content: `候选人的回答偏题了："${text}"。请用一句话追问，帮ta回到正轨。面试岗位：${s.role}。` },
            ]);
            const msg = followup.choices[0].message.content.trim();
            return res.end(JSON.stringify({ interrupt: true, reason: '偏题', msg }));
          }
        }

        res.end(JSON.stringify({ interrupt: false }));
      } catch (e) {
        res.end(JSON.stringify({ interrupt: false })); // fail safe — don't block on error
      }
    });
    return;
  }

  // API: TTS via Tencent Cloud (natural Chinese voices)
  if (req.url === '/api/tts' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        let { text } = JSON.parse(body);
        text = text.replace(/（[^）]*）|[\(（][^)）]*[\)）]/g, '');
        const client = new TtsClient({
          credential: { secretId: TENCENT_SECRET_ID, secretKey: TENCENT_SECRET_KEY },
          region: 'ap-guangzhou',
          profile: { httpProfile: { endpoint: 'tts.tencentcloudapi.com' } }
        });
        const result = await client.TextToVoice({
          Text: text,
          SessionId: Date.now().toString(36),
          VoiceType: 101003, // 智美自然女声 (精品模型)
          Codec: 'mp3',
          SampleRate: 16000,
          Volume: 5,
          Speed: 0,
          ModelType: 1
        });
        const audio = Buffer.from(result.Audio, 'base64');
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end(audio);
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end(); // fail silently, frontend falls back to browser TTS
      }
    });
    return;
  }

  // Static files
  let file = req.url === '/' ? '/index.html' : req.url;
  let fpath = path.join(__dirname, file);
  if (!fpath.startsWith(__dirname)) { res.writeHead(403); return res.end('403'); }
  try {
    const content = fs.readFileSync(fpath);
    res.writeHead(200, { 'Content-Type': getType(file) });
    res.end(content);
  } catch { res.writeHead(404); res.end('404'); }
});

async function callDeepSeek(messages) {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages, temperature: 0.8, max_tokens: 4096 }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'API error');
  return data;
}

server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
