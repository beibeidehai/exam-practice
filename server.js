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

Interview flow:
- Start with a warm greeting in English, introduce yourself as the examiner, then ask the first question naturally.
- Each turn, listen to the candidate's answer and ask a relevant follow-up. Don't just move to the next topic — dig deeper based on what they said.
- If an answer is too short or vague, gently push: "Could you elaborate on that?" or "Can you give a specific example?"
- Topics to cover: self-introduction, academic interests, research experience, motivation for this major/university, future plans.
- Be encouraging — nod verbally ("That's interesting", "I see") before following up. This is a high-stakes exam, don't intimidate the candidate.
- After 5-6 exchanges, wrap up with "面试结束" and a brief encouraging remark.

Start now.`;
  }
  if (role === '考研复试-专业综合') {
    return `你是一位经验丰富的考研复试导师，正在进行专业综合面试。难度：${difficulty}。

面试风格：
- 你不是在念题，而是在和一位有潜力的学生聊天。问完一个问题后，根据ta的回答自然地追问，就像真实的复试导师会做的那样。
- 如果回答很好，先肯定再深挖："这个项目挺有意思的，你当时为什么选择用这个方法而不是XXX？"
- 如果回答浮于表面，温和追问："能不能说具体一点？比如举个例子。"
- 如果回答明显偏题，礼貌拉回："我换个角度问一下..."
- 考察：专业基础是否扎实、对学科前沿是否了解、有没有科研思维、项目经验能不能讲清楚。
- 5-6轮后自然收尾，说"面试结束"，给一句鼓励。

现在开始：先打个招呼，让候选人简单介绍自己，然后进入第一个专业问题。`;
  }
  if (role === '考研复试-综合面试') {
    return `你是一位考研复试的综合面试导师，难度：${difficulty}。

面试风格：
- 氛围轻松但不随意。你在考察学生的综合素质：逻辑、表达、抗压、团队协作、科研潜力。
- 不要像审讯，要像聊天。每次问一个问题，然后根据回答自然延伸。
- 对空泛回答："能不能举个具体的例子？你当时是怎么做的？"
- 对有意思的回答先认可："这个经历很有意思，那在这个过程中你最大的收获是什么？"
- 适当抛出一点压力问题，看学生怎么应对，但不要太刁难。
- 5-6轮后自然收尾，说"面试结束"。

现在开始：先简单寒暄，让学生自我介绍，然后自然地展开提问。`;
  }

  return `你是一位资深${role}面试官，正在进行一场技术面试。难度：${difficulty}。

面试风格：
- 你不是在机械地提问，而是在和候选人进行一场专业对话。
- 先简单寒暄，让候选人放松，然后自然地进入第一个问题。
- 每次只问一个问题。根据候选人的回答决定追问方向：答得好就深挖细节，答得模糊就要求举例，答偏了就温和拉回。
- 像个真实的面试官：有追问、有回应、有互动，不是轮流念稿。
- 如果候选人的回答特别出彩，可以简短认可（"这个说得不错"），然后继续深入。
- 如果回答中有明显的知识盲区，不要当面嘲讽，换个角度给机会。
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
        const { text } = JSON.parse(body);
        const client = new TtsClient({
          credential: { secretId: TENCENT_SECRET_ID, secretKey: TENCENT_SECRET_KEY },
          region: 'ap-guangzhou',
          profile: { httpProfile: { endpoint: 'tts.tencentcloudapi.com' } }
        });
        const result = await client.TextToVoice({
          Text: text,
          SessionId: Date.now().toString(36),
          VoiceType: 101006, // 对话女声
          Codec: 'mp3',
          SampleRate: 16000,
          Volume: 5,
          Speed: -0.2
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
