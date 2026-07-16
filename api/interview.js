// Vercel serverless — single handler for /api/start, /api/answer, /api/interrupt
// Routed via vercel.json rewrites

const FILLER_WORDS = ['嗯', '啊', '呃', '额', '那个', '然后', '就是', '就是说', '这个', '怎么说呢', '其实', '反正', '对吧', '你懂吧'];
const MAX_ANSWER_LEN = 600;

// In-memory sessions (survives between warm calls, resets on cold start — fine for MVP)
const sessions = {};

function buildSystemPrompt(role, difficulty) {
  if (role === '考研复试-英语口语') {
    return `You are a postgraduate entrance re-examination English oral interview examiner. Difficulty: ${difficulty}. Conduct the entire interview in English. Ask one question at a time, follow up based on answers. Topics: self-introduction, research interests, academic background, why this university/major, future plans. Be professional but encouraging. After 4-5 exchanges, end with "面试结束". Start now: greet briefly, then ask your first question.`;
  }
  if (role === '考研复试-专业综合') {
    return `你是一个考研复试专业面试考官，难度：${difficulty}。每次只问一个专业问题，根据回答深挖细节。考察：专业基础知识、学科前沿动态、科研潜质、实验/项目经历。追问要犀利但不刁难。如果回答模糊或偏题，立刻打断追问具体细节。4-5轮后说"面试结束"。现在开始。`;
  }
  if (role === '考研复试-综合面试') {
    return `你是一个考研复试综合面试考官，难度：${difficulty}。每次只问一个问题，围绕科研经历、读研规划、综合素质展开。考察：逻辑思维、表达能力、抗压能力、科研潜力。对空泛回答打断追问具体案例。4-5轮后说"面试结束"。现在开始。`;
  }
  return `你是一个专业的${role}面试官，面试难度：${difficulty}。每次只问一个问题，根据上一轮回答决定追问方向。如果回答空泛或偏题，立刻打断追问。4-5轮后结束，说"面试结束"。风格专业但不严肃。现在开始面试。`;
}

function buildEvalPrompt(role, history, fluency) {
  const dims = `1. 专业知识（1-10）\n2. 逻辑表达（1-10）\n3. 语言流畅度（1-10）：填充词比例${fluency.fillerRatio}%，语速${fluency.wpm}字/分钟\n4. 临场应变（1-10）\n5. 沟通技巧（1-10）`;
  return `你是面试评估专家。以下为完整面试记录和语言数据。\n\n面试记录：\n${history}\n\n语言数据：总字数${fluency.totalChars}，填充词比例${fluency.fillerRatio}%，语速${fluency.wpm}字/分钟，填充词：${fluency.fillerList.join('、') || '无'}\n\n请从以下维度打分（1-10）：\n${dims}\n\n返回JSON：{"专业知识":8,"逻辑表达":7,"语言流畅度":6,"临场应变":7,"沟通技巧":8,"总分":36,"总结":"...","建议":["改进点1","改进点2"]}`;
}

function calcFluency(answers) {
  const allText = answers.join(' ');
  const totalChars = allText.length;
  if (totalChars === 0) return { totalChars: 0, fillerRatio: 0, wpm: 0, maxPause: 0, fillerList: [] };
  const found = {};
  FILLER_WORDS.forEach(w => {
    const re = new RegExp(w, 'g');
    const matches = allText.match(re);
    if (matches) found[w] = matches.length;
  });
  const fillerCount = Object.values(found).reduce((a, b) => a + b, 0);
  const fillerList = Object.entries(found).map(([w, c]) => `${w}(${c}次)`);
  const chineseChars = (allText.match(/[一-鿿]/g) || []).length;
  const englishWords = (allText.match(/[a-zA-Z]+/g) || []).length;
  const totalWords = chineseChars + englishWords;
  const fillerRatio = totalWords > 0 ? Math.round(fillerCount / totalWords * 1000) / 10 : 0;
  const estimatedMinutes = Math.max(1, totalChars / 300);
  const wpm = Math.round(totalWords / estimatedMinutes);
  return { totalChars, fillerRatio, wpm, maxPause: 0, fillerList };
}

async function callDeepSeek(messages) {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages, temperature: 0.8, max_tokens: 4096 }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'API error');
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const url = req.url || '';

  try {
    // /api/start
    if (url.includes('/api/start')) {
      const { role, difficulty } = req.body || {};
      if (!role) return res.status(400).json({ error: 'Missing role' });
      const sid = Date.now().toString(36);
      const msg = { role: 'system', content: buildSystemPrompt(role, difficulty) };
      sessions[sid] = { role, difficulty, history: [msg], questionCount: 0, answers: [] };

      const result = await callDeepSeek(sessions[sid].history);
      const reply = result.choices[0].message.content;
      sessions[sid].history.push({ role: 'assistant', content: reply });
      sessions[sid].questionCount = 1;

      return res.json({ sid, reply });
    }

    // /api/answer
    if (url.includes('/api/answer')) {
      const { sid, answer } = req.body || {};
      const s = sessions[sid];
      if (!s) return res.status(400).json({ error: 'Session expired' });

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
        return res.json({ done: true, evaluation });
      }

      const result = await callDeepSeek(s.history);
      const reply = result.choices[0].message.content;
      s.history.push({ role: 'assistant', content: reply });

      return res.json({ done: false, reply });
    }

    // /api/interrupt
    if (url.includes('/api/interrupt')) {
      const { sid, text } = req.body || {};
      const s = sessions[sid];
      if (!s || !text) return res.json({ interrupt: false });

      if (text.length > MAX_ANSWER_LEN) {
        return res.json({ interrupt: true, reason: '回答超长', msg: '抱歉打断一下，你的回答有些长了，能否用一句话总结核心观点？' });
      }

      let fillerCount = 0;
      FILLER_WORDS.forEach(w => {
        const re = new RegExp(w, 'g');
        const matches = text.match(re);
        if (matches) fillerCount += matches.length;
      });
      if (text.length > 100 && fillerCount / text.length > 0.08) {
        return res.json({ interrupt: true, reason: '填充词过多', msg: '我打断一下，注意到你用了比较多的语气词，试着放慢语速，想清楚再说。' });
      }

      if (text.length > 80) {
        const prompt = `你是面试官。候选人正在回答。当前转写："${text}"。判断是否明显偏题或逻辑混乱。回复"打断"或"继续"。`;
        const result = await callDeepSeek([{ role: 'user', content: prompt }]);
        const reply = result.choices[0].message.content.trim();
        if (reply.includes('打断')) {
          const followup = await callDeepSeek([{ role: 'user', content: `候选人回答偏题："${text}"。用一句话追问帮ta回到正轨。角色：${s.role}。` }]);
          return res.json({ interrupt: true, reason: '偏题', msg: followup.choices[0].message.content.trim() });
        }
      }

      return res.json({ interrupt: false });
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
