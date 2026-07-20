// Vercel serverless — single handler for /api/start, /api/answer, /api/interrupt, /api/tts
// Routed via vercel.json rewrites

const tencentcloud = require('tencentcloud-sdk-nodejs-tts');
const TtsClient = tencentcloud.tts.v20190823.Client;

const FILLER_WORDS = ['嗯', '啊', '呃', '额', '那个', '然后', '就是', '就是说', '这个', '怎么说呢', '其实', '反正', '对吧', '你懂吧'];
const MAX_ANSWER_LEN = 600;

// In-memory sessions (survives between warm calls, resets on cold start — fine for MVP)
const sessions = {};

function buildSystemPrompt(role, difficulty) {
  if (role === '考研复试-英语口语') {
    return `You are a friendly yet professional English oral examiner for a Chinese postgraduate entrance interview. Difficulty: ${difficulty}. Start with a warm greeting, then ask the first question naturally. Each turn, listen and ask a relevant follow-up — dig deeper based on what they said. If an answer is too short or vague, gently push for elaboration. Be encouraging, nod verbally before following up. After 5-6 exchanges, wrap up with "面试结束" and a brief encouraging remark.`;
  }
  if (role === '考研复试-专业综合') {
    return `你是一位经验丰富的考研复试导师。难度：${difficulty}。你不是在念题，而是在和一位有潜力的学生聊天。问完一个问题后自然追问，像真实复试导师。回答好就先肯定再深挖，回答浮于表面就温和追问细节，偏题就礼貌拉回。考察专业基础、学科前沿、科研思维、项目经验。5-6轮后自然收尾，说"面试结束"。`;
  }
  if (role === '考研复试-综合面试') {
    return `你是一位考研复试综合面试导师。难度：${difficulty}。氛围轻松但不随意，像聊天一样考察学生的逻辑、表达、抗压、团队协作、科研潜力。每次一个问题，根据回答自然延伸。空泛回答追问具体案例，好的回答先认可再深入。适当抛出压力问题但不要太刁难。5-6轮后自然收尾，说"面试结束"。`;
  }
  return `你是一位资深${role}面试官。难度：${difficulty}。你不是在机械提问，而是在进行一场专业对话。先简单寒暄让候选人放松，然后自然进入第一个问题。每次只问一个问题，根据回答决定追问方向。答得好就深挖，答得模糊就要求举例，答偏了就温和拉回。像个真实面试官：有追问、有回应、有互动。5-6轮后自然收尾，说"面试结束"。`;
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

    // /api/tts
    if (url.includes('/api/tts')) {
      let { text } = req.body || {};
      if (!text) return res.status(400).json({ error: 'Missing text' });
      text = text.replace(/（[^）]*）|[\(（][^)）]*[\)）]/g, '');
      try {
        const client = new TtsClient({
          credential: { secretId: process.env.TENCENT_SECRET_ID, secretKey: process.env.TENCENT_SECRET_KEY },
          region: 'ap-guangzhou',
          profile: { httpProfile: { endpoint: 'tts.tencentcloudapi.com' } }
        });
        const result = await client.TextToVoice({
          Text: text,
          SessionId: Date.now().toString(36),
          VoiceType: 101003,
          Codec: 'mp3',
          SampleRate: 16000,
          Volume: 5,
          Speed: 0,
          ModelType: 1
        });
        const audio = Buffer.from(result.Audio, 'base64');
        res.setHeader('Content-Type', 'audio/mpeg');
        return res.send(audio);
      } catch (e) {
        return res.status(200).setHeader('Content-Type', 'audio/mpeg').send(Buffer.alloc(0));
      }
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
