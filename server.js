const http = require('http');
const fs = require('fs');
const path = require('path');

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const PORT = process.env.PORT || 3456;
const sessions = {};

const FILLER_WORDS = ['嗯', '啊', '呃', '额', '那个', '然后', '就是', '就是说', '这个', '怎么说呢', '其实', '反正', '对吧', '你懂吧'];
const MAX_ANSWER_LEN = 600; // chars — warn if answer exceeds this

function getType(file) {
  const map = { '.html': 'text/html;charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
  return map[path.extname(file)] || 'text/plain';
}

function buildSystemPrompt(role, difficulty) {
  // 考研复试 special handling
  if (role === '考研复试-英语口语') {
    return `You are a postgraduate entrance re-examination English oral interview examiner. Difficulty: ${difficulty}.

Your task:
1. Conduct the entire interview in English
2. Ask one question at a time, follow up based on candidate's answers
3. Topics: self-introduction, research interests, academic background, why this university/major, future plans
4. Be professional but encouraging — this is a high-stakes exam for the candidate
5. After 4-5 exchanges, end with "面试结束"

Start now: greet the candidate briefly, then ask your first question.`;
  }
  if (role === '考研复试-专业综合') {
    return `你是一个考研复试专业面试考官，难度：${difficulty}。

你的任务：
1. 每次只问一个专业问题，根据回答深挖细节
2. 考察范围：专业基础知识、学科前沿动态、科研潜质、实验/项目经历
3. 追问要犀利但不刁难，像真实复试导师一样
4. 如果回答模糊或偏题，立刻打断追问具体细节
5. 4-5轮后结束，说"面试结束"

现在开始：请候选人简要自我介绍，然后问第一个专业问题。`;
  }
  if (role === '考研复试-综合面试') {
    return `你是一个考研复试综合面试考官，难度：${difficulty}。

你的任务：
1. 每次只问一个问题，围绕科研经历、读研规划、综合素质展开
2. 考察：逻辑思维、表达能力、抗压能力、科研潜力、团队协作
3. 对空泛回答要打断追问具体案例："能不能举个具体的例子？"
4. 风格介于严肃和轻松之间，模拟真实复试氛围
5. 4-5轮后结束，说"面试结束"

现在开始：先让候选人做自我介绍，然后提问。`;
  }

  // Standard job interview
  return `你是一个专业的${role}面试官，面试难度：${difficulty}。
你的任务：
1. 每次只问一个问题，根据候选人上一轮的回答决定追问方向
2. 如果候选人的回答过于空泛或偏题，立刻打断追问："请说具体一点"或"能举个例子吗"
3. 4-5轮后结束，说"面试结束"
4. 风格专业但不严肃，像真实面试官一样互动

现在开始面试。先做自我介绍，然后问第一个问题。`;
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
